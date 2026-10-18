// 路人生活行為（P10）：在漫步（brain.state === 'wander'、ped.state === 'walk'）的骨架行人上排程「生活活動」，讓街上熱鬧一點
// 純邏輯、不 import three（node 無頭測試可直接載入）；3D 台詞泡泡的 THREE 由呼叫端注入（createSpeechBubbles）
//
// 活動（ped.amb.act）：只對 near / mid 級骨架行人（traffic.peds）生效，替身維持原樣；活動結束交還漫步
//   phone_talk / phone_text：停下講電話 / 滑手機 PHONE_MIN–PHONE_MAX 秒，面向隨機
//   chat：2–3 人聊天小群——發起者停下等人（look_around），CHAT_WAIT 內有漫步者經過 CHAT_JOIN_DIST 內就加入；
//         成員彼此面對（面向成員重心）、chat_gesture / look_around 交錯，CHAT_MIN–CHAT_MAX 秒後散開；只在寬人行道 / 廣場 / 百貨門口 /
//         秋紅谷（route.kind ∈ CHAT_KINDS）或熱點（夜市等）發起
//   jog：JOG_WINDOWS 時段（早 6–9、傍晚 17–20）且路線在公園 / 秋紅谷步道（route.kind ∈ JOG_KINDS）→ 以 JOG_SPEED 沿路線慢跑
//   sit：SEAT_REACH 內有空的座位道具（setSeats）才坐（sit_idle）；沒有座位就不抽這個活動
//   look_around：原地東張西望；兩個漫步者迎面相遇偶爾 wave（上半身一次性，邊走邊揮）
//   film：附近有打鬥 / 車禍 / 槍擊（notify incident）→ FILM_CHANCE 的漫步者停下舉手機拍（面向事發點，距離 ≥ FILM_MIN_DIST）
//   同時進行活動的比例：依時段目標（TARGET_DAY / TARGET_NIGHT）以缺額控制啟動機率；熱點（夜市時段）另有較高目標 HOT_TARGET
// 反應（ped.amb.react，不計入活動比例）：
//   cower：玩家持槍瞄準 AIM_RANGE 內、瞄準線 AIM_LATERAL 內的市民 → 蹲縮 COWER_MIN–COWER_MAX 秒，之後 brain.onThreatened(玩家) 照既有邏輯逃跑
//   shout：玩家衝刺（速度 > BUMP_SPEED）撞到 / 擦過（BUMP_DIST 內）→ angry_shout、轉向玩家、頭上台詞泡泡（SHOUT_LINES 隨機，池上限 BUBBLE_MAX）
//   大腦狀態的動畫對應：look（喇叭轉頭）→ look_around、glare → angry_shout、watch 且 brain.filming（npc-ai 拍片分流）→ phone_film
// 不介入：倒地 / 起身 / 走回路線（ped.state !== 'walk'）、被拖出待起身的司機（ped.pendingFrom）、大腦非漫步（逃跑 / 還手 / 圍觀…）者
//   不開始活動也不起反應（cower / shout）；活動中 ped.state 維持 'walk'，回收 / 骨架借用照常（detach 收尾）
// 移動 / 面向交給 traffic-peds.js walkPed：ped.pace（步速倍率，0 = 停下、慢跑 = JOG_SPEED / speed）、ped.faceHold（覆寫面向 yaw，null = 沿路線）
// 動畫交給 CharacterAnimator.setAmbient(name|null)（循環 overlay）/ playGesture(name)（上半身一次性）；缺 clip 依 AMBIENT_CLIP_FALLBACK
//
// createPedAmbient({ seed, bubbles, hotspots, seats }) → {
//   attach(ped) / detach(ped)：骨架掛上 / 回池時呼叫（重設 pace / faceHold / 動畫 overlay、設定 brain.filmChance）
//   update(t, simDt)：每幀（Traffic.sync 的 thinkPeds 之後）；t = Traffic（peds / frame / stagger / context）；活動判斷以 stagger 錯開
//     （near 每 EVERY_NEAR 幀、mid 每 EVERY_MID 幀，累積模擬秒數）；瞄準 / 衝撞偵測每幀但只在玩家瞄準 / 衝刺時掃
//   updateBubbles(dt)：每幀（渲染 dt）推進台詞泡泡淡出
//   setContext({ hour, aiming, aimDirX, aimDirZ })：遊戲時刻、玩家是否持槍瞄準與瞄準水平方向（原點 = 玩家位置）
//   notify(evt)：{ type: 'incident', x, z, kind: 'fight'|'crash'|'gunshot' } / { type: 'bump', ped } / { type: 'aim', ped }
//   setSeats([{ x, z, yaw }]) / setHotspots([{ x, z, r, from, to }])、start(ped, name)、stats（含 allocs 配置計數器）、activityOf(ped)
// }
// 不在每幀配置新物件：活動紀錄（ped.amb）掛上時配置一次並隨骨架重用、聊天群組 / 事件 / 泡泡皆為預配置池；
//   隨機一律用紀錄內的 32-bit 狀態（同 mulberry32 演算法，不配置閉包）
import { seedFromId, GUNSHOT_RADIUS } from './npc-ai.js';
import { NIGHT_MARKET_DELIVERY } from './missions/events.js';

// ---------- clip 名稱與缺檔退回（animator 共用） ----------
export const AMBIENT_LOOPS = ['phone_talk', 'phone_text', 'phone_film', 'chat_gesture', 'look_around', 'sit_idle', 'jog', 'cower'];
export const AMBIENT_GESTURES = ['wave', 'angry_shout', 'cheer']; // 上半身、不循環
export const AMBIENT_CLIPS = [...AMBIENT_LOOPS, ...AMBIENT_GESTURES];
export const AMBIENT_UPPER = new Set(['phone_talk', 'phone_text', 'phone_film', 'wave', 'angry_shout', 'cheer']);
// 缺 clip 時依序嘗試的替代（'idle' = 不疊加 overlay，等同原本的站立 / 移動動畫）
export const AMBIENT_CLIP_FALLBACK = {
  phone_talk: ['idle'],
  phone_text: ['idle'],
  phone_film: ['idle'],
  chat_gesture: ['idle'],
  look_around: ['idle'],
  sit_idle: ['idle'],
  jog: ['run', 'walk', 'idle'],
  cower: ['hit', 'idle'],
  wave: ['idle'],
  angry_shout: ['idle'],
  cheer: ['idle'],
};
// 缺 clip 解析：has(name) → boolean；回傳實際使用的 clip 名稱或 null（未知名稱 / 全缺）
export function resolveAmbientClip(name, has) {
  const fb = AMBIENT_CLIP_FALLBACK[name];
  if (!fb) return null;
  if (has(name)) return name;
  for (const n of fb) if (has(n)) return n;
  return null;
}

// ---------- 參數（手感值，推測） ----------
export const EVERY_NEAR = 2; // 活動判斷間隔（幀）：near
export const EVERY_MID = 6; // mid
export const TARGET_DAY = 0.32; // 同時進行活動的目標比例（日間）
export const TARGET_NIGHT = 0.26; // 深夜（NIGHT_FROM–NIGHT_TO）較少
export const NIGHT_FROM = 22;
export const NIGHT_TO = 6;
export const HOT_TARGET = 0.5; // 熱點（夜市時段）附近的目標比例
export const START_RATE = 0.6; // 缺額時每人每秒啟動活動的機率率（1 − e^(−rate·dt)，與幀率無關）
export const COOLDOWN_MIN = 6; // 活動結束後至少走這麼久才再抽（秒）
export const COOLDOWN_MAX = 15;
export const PHONE_MIN = 5;
export const PHONE_MAX = 20;
export const LOOK_MIN = 3;
export const LOOK_MAX = 6;
export const CHAT_MIN = 20;
export const CHAT_MAX = 60;
export const CHAT_WAIT = 8; // 發起者等人加入的時間；沒人加入就結束（只算東張西望）
export const CHAT_JOIN_DIST = 2.4; // 漫步者經過發起者此距離（m）內就加入
export const CHAT_SIZE = 3; // 每群上限
export const CHAT_SWAP_MIN = 3; // chat_gesture / look_around 交錯間隔（秒）
export const CHAT_SWAP_MAX = 6;
export const CHAT_CHEER = 0.08; // 換動作時偶爾笑出來（cheer）
export const CHAT_KINDS = new Set(['plaza', 'mall', 'qiuhonggu']);
export const MAX_GROUPS = 24;
export const JOG_SPEED = 2.8; // 慢跑速度（m/s）
export const JOG_REF_SPEED = 2.8; // jog clip 播放速率 1.0 的參考速度（缺 clip 改用 run 時照 run 的參考速度換算）
export const JOG_WINDOWS = [[6, 9], [17, 20]];
export const JOG_KINDS = new Set(['qiuhonggu', 'footway']);
export const JOG_PICK = 0.5; // 符合慢跑條件時抽中慢跑的比例
export const JOG_MIN = 30;
export const JOG_MAX = 90;
export const SIT_MIN = 15;
export const SIT_MAX = 40;
export const SEAT_REACH = 1.5;
export const MEET_EVERY = 1; // 相遇（揮手 / 加入聊天）檢查間隔（秒）
export const WAVE_DIST = 3;
export const WAVE_CHANCE = 0.2;
export const WAVE_COOLDOWN = 20;
export const FILM_CHANCE = 0.3; // 目擊者拍片比例（npc-ai 的 8 m 內目擊者與本模組的遠處漫步者共用）
export const FILM_MIN_DIST = 8;
export const FILM_RADIUS = 25; // 打鬥 / 車禍：FILM_MIN_DIST–此距離的漫步者可能停下拍
export const FILM_RADIUS_GUNSHOT = 40; // 槍擊：30 m 內大腦已逃跑，外圈的人拍
export const FILM_MIN = 5;
export const FILM_MAX = 10;
export const INCIDENT_SLOTS = 4;
export const INCIDENT_TTL = 1.5; // 事件發出後此秒數內被判斷到的人才反應（mid 降頻也來得及）
export const INCIDENT_MERGE = 10; // 同一處（m）、未過期的事件合併（打架連續出拳不重複觸發）
export const AIM_RANGE = 10;
export const AIM_LATERAL = 1.2; // 離瞄準線此距離（m）內視為被瞄準
export const COWER_MIN = 1;
export const COWER_MAX = 1.8;
export const COWER_COOLDOWN = 8;
export const BUMP_SPEED = 6; // 玩家水平速度高於此（m/s，步行 4.2、衝刺 8.5）才算衝撞
export const PLAYER_TELEPORT_SPEED = 15; // 玩家位移換算速度高於此（m/s）視為下車 / 瞬移，不判定衝撞
export const BUMP_DIST = 0.9; // 玩家與行人中心距離（m；膠囊半徑 0.35 + 行人半徑 + 擦過餘裕）
export const SHOUT_TIME = 1.6;
export const SHOUT_COOLDOWN = 6;
export const SHOUT_LINES = ['走路不看路喔！', '欸！小心一點啦！', '是在衝啥啦！', '撞到人不會說歹勢喔？', '靠夭喔～'];
export const BUBBLE_MAX = 3;
export const BUBBLE_LIFE = 2; // 台詞顯示總長（秒）：BUBBLE_HOLD 後線性淡出到 0
export const BUBBLE_HOLD = 0.5;
export const BUBBLE_HEIGHT = 2.1; // 泡泡高度（腳底起算，m）
export const DEFAULT_HOUR = 16.5; // 同 save.js defaultSave 的 world.hour
// 熱點：夜市（外送取餐點的商圈，17–24 時）
export const DEFAULT_HOTSPOTS = [{ x: NIGHT_MARKET_DELIVERY.pickup.x, z: NIGHT_MARKET_DELIVERY.pickup.z, r: 45, from: 17, to: 24 }];
const SALT = 0x50a1;

// 活動權重（依情境再乘倍率）
const W_PHONE_TALK = 0.22;
const W_PHONE_TEXT = 0.22;
const W_LOOK = 0.14;
const W_CHAT = 0.28;
const W_SIT = 0.3;

const TAU = Math.PI * 2;

// 紀錄內的 32-bit 狀態亂數（mulberry32 同演算法，不配置閉包）
function rnd(a) {
  a.seed = (a.seed + 0x6d2b79f5) >>> 0;
  let t = a.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function inWindow(h, from, to) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

export function isJogHour(h) {
  for (const w of JOG_WINDOWS) if (inWindow(h, w[0], w[1])) return true;
  return false;
}

export function targetRatio(h, hot = false) {
  if (hot) return HOT_TARGET;
  return inWindow(h, NIGHT_FROM, NIGHT_TO) ? TARGET_NIGHT : TARGET_DAY;
}

// ---------- 台詞泡泡池（純邏輯；外觀由 makeSlot 提供） ----------
// makeSlot(i) → { setText(text), setOpacity(o), setVisible(v), setPosition(x, y, z) }；同時最多 max 個，滿了重用最舊的
export function createBubblePool({ max = BUBBLE_MAX, makeSlot = null } = {}) {
  const slots = [];
  for (let i = 0; i < max; i++) slots.push({ view: makeSlot ? makeSlot(i) : null, anchor: null, text: '', t: 0, seq: 0 });
  let seq = 0;
  const place = (s) => {
    const a = s.anchor;
    if (s.view && a) s.view.setPosition(a.x, (Number.isFinite(a.y) ? a.y : 0) + BUBBLE_HEIGHT, a.z);
  };
  const api = {
    max,
    slots,
    get active() {
      let n = 0;
      for (const s of slots) if (s.anchor) n++;
      return n;
    },
    // 顯示台詞；anchor = 有 x / y / z 的物件（行人），每次 update 跟著移動
    show(text, anchor) {
      let s = null;
      for (const q of slots) if (q.anchor === anchor) s = q; // 同一人重講：換掉自己的泡泡
      if (!s) for (const q of slots) if (!q.anchor && !s) s = q;
      if (!s) for (const q of slots) if (!s || q.seq < s.seq) s = q;
      s.anchor = anchor;
      s.text = text;
      s.t = 0;
      s.seq = ++seq;
      if (s.view) {
        s.view.setText(text);
        s.view.setOpacity(1);
        s.view.setVisible(true);
      }
      place(s);
      return s;
    },
    update(dt) {
      for (const s of slots) {
        if (!s.anchor) continue;
        s.t += dt;
        if (s.t >= BUBBLE_LIFE) {
          api._hide(s);
          continue;
        }
        if (s.view) s.view.setOpacity(s.t <= BUBBLE_HOLD ? 1 : 1 - (s.t - BUBBLE_HOLD) / (BUBBLE_LIFE - BUBBLE_HOLD));
        place(s);
      }
    },
    // 行人回池時收掉他的泡泡
    release(anchor) {
      for (const s of slots) if (s.anchor === anchor) api._hide(s);
    },
    _hide(s) {
      s.anchor = null;
      if (s.view) s.view.setVisible(false);
    },
  };
  return api;
}

// three Sprite + CanvasTexture 外觀（物件池化：BUBBLE_MAX 張畫布 / 材質 / sprite 一次建好）；沒有 document（node）時只跑邏輯
export function createSpeechBubbles(THREE, scene, { max = BUBBLE_MAX } = {}) {
  const canDraw = typeof document !== 'undefined' && THREE && scene;
  const W = 512;
  const H = 128;
  const makeSlot = canDraw
    ? () => {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const g = canvas.getContext('2d');
        const tex = new THREE.CanvasTexture(canvas);
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 1 });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(2.4, 0.6, 1);
        sprite.center.set(0.5, 0);
        sprite.visible = false;
        sprite.renderOrder = 10;
        sprite.name = 'pedSpeechBubble';
        scene.add(sprite);
        return {
          sprite,
          setText(text) {
            if (!g) return;
            g.clearRect(0, 0, W, H);
            g.font = 'bold 54px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            const tw = Math.min(W - 8, g.measureText(text).width + 48);
            g.fillStyle = 'rgba(255,255,255,0.92)';
            g.fillRect((W - tw) / 2, 10, tw, H - 20);
            g.lineWidth = 8;
            g.strokeStyle = 'rgba(0,0,0,0.85)';
            g.strokeText(text, W / 2, H / 2, W - 24);
            g.fillStyle = '#d0021b';
            g.fillText(text, W / 2, H / 2, W - 24);
            tex.needsUpdate = true;
          },
          setOpacity(o) {
            mat.opacity = o;
          },
          setVisible(v) {
            sprite.visible = v;
          },
          setPosition(x, y, z) {
            sprite.position.set(x, y, z);
          },
        };
      }
    : null;
  return createBubblePool({ max, makeSlot });
}

// ---------- 系統 ----------
export function createPedAmbient({ seed = 0, bubbles = null, hotspots = DEFAULT_HOTSPOTS, seats = [] } = {}) {
  const stats = { allocs: 0, started: 0, ended: 0, eligible: 0, active: 0, chats: 0, joins: 0, films: 0, cowers: 0, shouts: 0, waves: 0, jogs: 0, sits: 0 };
  const ctx = { hour: DEFAULT_HOUR, aiming: false, aimDirX: 0, aimDirZ: 1 };
  let seatList = seats.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw || 0, by: null }));
  let hot = hotspots.slice();
  const groups = [];
  for (let i = 0; i < MAX_GROUPS; i++) groups.push({ used: false, n: 0, members: [null, null, null], cx: 0, cz: 0, t: 0, dur: 0 });
  const incidents = [];
  for (let i = 0; i < INCIDENT_SLOTS; i++) incidents.push({ id: 0, x: 0, z: 0, kind: 'fight', age: Infinity });
  let incidentSeq = 0;
  const cnt = [0, 0]; // 本幀合格人數（一般 / 熱點）
  const act = [0, 0]; // 本幀活動中人數
  const player = { x: 0, z: 0, speed: 0, have: false, acc: 0 };

  // ---- 單人工具 ----
  const newRecord = () => {
    stats.allocs++;
    return {
      act: null, t: 0, dur: 0, cool: 0, acc: 0, clip: null, seed: 0, group: null, seat: null,
      faceX: 0, faceZ: 0, react: null, reactT: 0, reactDur: 0, cowerCool: 0, shoutCool: 0,
      meetT: 0, waveCool: 0, incSeen: new Array(INCIDENT_SLOTS).fill(0), glared: false, swapT: 0, hot: 0, threat: null, hashBase: 0,
    };
  };

  function setClip(p, a, name) {
    if (a.clip === name) return;
    a.clip = name;
    if (p.anim && p.anim.setAmbient) p.anim.setAmbient(name);
  }

  function gesture(p, name) {
    if (p.anim && p.anim.playGesture) p.anim.playGesture(name);
  }

  function hotAt(x, z) {
    const h = ctx.hour;
    for (const s of hot) {
      if (!inWindow(h, s.from ?? 0, s.to ?? 24)) continue;
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz <= s.r * s.r) return 1;
    }
    return 0;
  }

  function faceTo(p, x, z) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz > 1e-8) p.faceHold = Math.atan2(dx, dz);
  }

  function leaveGroup(p, a) {
    const g = a.group;
    a.group = null;
    if (!g) return;
    const m = g.members;
    for (let i = 0; i < g.n; i++) {
      if (m[i] !== p) continue;
      m[i] = m[g.n - 1];
      m[g.n - 1] = null;
      g.n--;
      break;
    }
    if (g.n === 0) g.used = false;
    else if (g.n === 1 && g.dur > 0) g.t = g.dur; // 聊天中剩一人 → 散會
  }

  function stopMove(p) {
    p.pace = 0;
  }

  function endActivity(p, a) {
    if (!a.act) return;
    if (a.group) leaveGroup(p, a);
    if (a.seat) {
      a.seat.by = null;
      a.seat = null;
    }
    a.act = null;
    a.t = 0;
    a.cool = COOLDOWN_MIN + rnd(a) * (COOLDOWN_MAX - COOLDOWN_MIN);
    p.pace = 1;
    p.faceHold = null;
    setClip(p, a, null);
    stats.ended++;
  }

  function endReact(p, a) {
    a.react = null;
    a.reactT = 0;
    if (!a.act) {
      p.pace = 1;
      p.faceHold = null;
      setClip(p, a, null);
    }
  }

  function begin(p, a, name, dur, clip) {
    a.act = name;
    a.t = 0;
    a.dur = dur;
    setClip(p, a, clip);
    stats.started++;
    act[a.hot]++;
  }

  function startPhone(p, a) {
    const talk = rnd(a) < 0.5;
    stopMove(p);
    p.faceHold = p.yaw + (rnd(a) - 0.5) * Math.PI; // 面向隨機（大致朝原方向左右各 90° 內）
    begin(p, a, talk ? 'phone_talk' : 'phone_text', PHONE_MIN + rnd(a) * (PHONE_MAX - PHONE_MIN), talk ? 'phone_talk' : 'phone_text');
  }

  function startLook(p, a) {
    stopMove(p);
    begin(p, a, 'look_around', LOOK_MIN + rnd(a) * (LOOK_MAX - LOOK_MIN), 'look_around');
  }

  function freeGroup() {
    for (const g of groups) if (!g.used) return g;
    return null;
  }

  function startChat(p, a) {
    const g = freeGroup();
    if (!g) return false;
    g.used = true;
    g.n = 1;
    g.members[0] = p;
    g.members[1] = null;
    g.members[2] = null;
    g.cx = p.x;
    g.cz = p.z;
    g.t = 0;
    g.dur = 0; // 0 = 等人中；有人加入才抽聊天長度
    a.group = g;
    stopMove(p);
    begin(p, a, 'chat', CHAT_WAIT, 'look_around');
    return true;
  }

  function joinChat(p, a, g) {
    const m = g.members;
    m[g.n++] = p;
    a.group = g;
    stopMove(p);
    if (g.dur === 0) {
      g.dur = CHAT_MIN + rnd(a) * (CHAT_MAX - CHAT_MIN);
      g.t = 0;
      stats.chats++;
    }
    stats.joins++;
    begin(p, a, 'chat', Infinity, 'chat_gesture');
    a.swapT = CHAT_SWAP_MIN + rnd(a) * (CHAT_SWAP_MAX - CHAT_SWAP_MIN);
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < g.n; i++) {
      cx += m[i].x;
      cz += m[i].z;
    }
    g.cx = cx / g.n;
    g.cz = cz / g.n;
  }

  function startJog(p, a) {
    p.pace = p.speed > 1e-6 ? JOG_SPEED / p.speed : 1;
    p.faceHold = null;
    begin(p, a, 'jog', JOG_MIN + rnd(a) * (JOG_MAX - JOG_MIN), 'jog');
    stats.jogs++;
  }

  function seatNear(p) {
    for (const s of seatList) {
      if (s.by) continue;
      if (Math.hypot(s.x - p.x, s.z - p.z) <= SEAT_REACH) return s;
    }
    return null;
  }

  function startSit(p, a, s) {
    s.by = p;
    a.seat = s;
    stopMove(p);
    p.faceHold = s.yaw;
    begin(p, a, 'sit', SIT_MIN + rnd(a) * (SIT_MAX - SIT_MIN), 'sit_idle');
    stats.sits++;
  }

  function startFilm(p, a, inc) {
    if (a.act) endActivity(p, a);
    stopMove(p);
    faceTo(p, inc.x, inc.z);
    a.faceX = inc.x;
    a.faceZ = inc.z;
    begin(p, a, 'film', FILM_MIN + rnd(a) * (FILM_MAX - FILM_MIN), 'phone_film');
    stats.films++;
  }

  function chooseActivity(p, a) {
    const kind = p.route ? p.route.kind : null;
    const h = ctx.hour;
    if (isJogHour(h) && JOG_KINDS.has(kind) && rnd(a) < JOG_PICK) return startJog(p, a);
    const seat = seatList.length ? seatNear(p) : null;
    const night = inWindow(h, NIGHT_FROM, NIGHT_TO);
    const chatOk = CHAT_KINDS.has(kind) || a.hot === 1;
    const wTalk = W_PHONE_TALK;
    const wText = W_PHONE_TEXT * (night ? 1.6 : 1);
    const wLook = W_LOOK;
    const wChat = chatOk ? W_CHAT * (a.hot ? 2 : 1) * (night && !a.hot ? 0.5 : 1) : 0;
    const wSit = seat ? W_SIT : 0;
    let r = rnd(a) * (wTalk + wText + wLook + wChat + wSit);
    if ((r -= wSit) < 0) return startSit(p, a, seat);
    if ((r -= wChat) < 0 && startChat(p, a)) return;
    if ((r -= wLook) < 0) return startLook(p, a);
    startPhone(p, a);
  }

  // 相遇：附近有等人的聊天群組就加入；否則迎面相遇的漫步者偶爾互相揮手
  function meet(p, a, peds) {
    const cos = Math.cos(p.yaw);
    const sin = Math.sin(p.yaw);
    for (const q of peds) {
      if (q === p) continue;
      const b = q.amb;
      if (!b) continue;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const d2 = dx * dx + dz * dz;
      const g = b.group;
      // 加入不另看缺額：群組數本身受缺額控制，加入者算進活動人數後自然少開新活動
      if (g && b.act === 'chat' && g.n < CHAT_SIZE && g.t < (g.dur || CHAT_WAIT) - 3 && d2 <= CHAT_JOIN_DIST * CHAT_JOIN_DIST) {
        joinChat(p, a, g);
        return;
      }
      if (a.waveCool > 0 || b.act || b.react || b.waveCool > 0 || q.state !== 'walk' || d2 > WAVE_DIST * WAVE_DIST || d2 < 1e-6) continue;
      // 迎面：彼此朝向相反、且對方在自己前方
      if (sin * Math.sin(q.yaw) + cos * Math.cos(q.yaw) > -0.5 || dx * sin + dz * cos <= 0) continue;
      if (!q.brain || q.brain.state !== 'wander') continue;
      if (rnd(a) < WAVE_CHANCE) {
        gesture(p, 'wave');
        gesture(q, 'wave');
        stats.waves++;
      }
      a.waveCool = WAVE_COOLDOWN;
      b.waveCool = WAVE_COOLDOWN;
      return;
    }
  }

  function updateActivity(p, a, dt) {
    a.t += dt;
    const g = a.group;
    if (a.act === 'chat') {
      if (g.dur === 0) {
        // 等人中：發起者計時（CHAT_WAIT）
        g.t += dt;
        if (g.t >= CHAT_WAIT) return endActivity(p, a);
        return;
      }
      if (g.members[0] === p) g.t += dt; // 群組時間只由第一位成員推進
      if (g.t >= g.dur) return endActivity(p, a);
      faceTo(p, g.cx, g.cz);
      a.swapT -= dt;
      if (a.swapT <= 0) {
        a.swapT = CHAT_SWAP_MIN + rnd(a) * (CHAT_SWAP_MAX - CHAT_SWAP_MIN);
        setClip(p, a, a.clip === 'chat_gesture' ? 'look_around' : 'chat_gesture');
        if (rnd(a) < CHAT_CHEER) gesture(p, 'cheer');
      }
      return;
    }
    if (a.act === 'jog' && !isJogHour(ctx.hour)) return endActivity(p, a);
    if (a.act === 'film') faceTo(p, a.faceX, a.faceZ);
    if (a.t >= a.dur) endActivity(p, a);
  }

  // ---- 反應：瞄準 cower / 衝撞 shout ----
  function startCower(p, a, from) {
    if (a.react || a.cowerCool > 0 || !p.brain || p.brain.state !== 'wander' || p.state !== 'walk' || p.pendingFrom) return false;
    if (a.act) endActivity(p, a);
    a.react = 'cower';
    a.reactT = 0;
    a.reactDur = COWER_MIN + rnd(a) * (COWER_MAX - COWER_MIN);
    a.cowerCool = COWER_COOLDOWN;
    a.threat = from;
    stopMove(p);
    faceTo(p, from.pos.x, from.pos.z);
    setClip(p, a, 'cower');
    stats.cowers++;
    return true;
  }

  function startShout(p, a, from) {
    // 倒地 / 起身 / 走回路線中、被拖出待起身的司機不罵人（大腦剛建好時仍是 wander，不能只看大腦）
    if (a.react || a.shoutCool > 0 || !p.brain || p.brain.state !== 'wander' || p.state !== 'walk' || p.pendingFrom) return false;
    if (a.act) endActivity(p, a);
    a.react = 'shout';
    a.reactT = 0;
    a.reactDur = SHOUT_TIME;
    a.shoutCool = SHOUT_COOLDOWN;
    stopMove(p);
    if (from) faceTo(p, from.pos.x, from.pos.z);
    setClip(p, a, null);
    gesture(p, 'angry_shout');
    if (bubbles) bubbles.show(SHOUT_LINES[Math.floor(rnd(a) * SHOUT_LINES.length)], p);
    stats.shouts++;
    return true;
  }

  function finishReact(p, a) {
    const kind = a.react;
    const th = a.threat;
    a.threat = null;
    endReact(p, a);
    // 蹲縮完照既有邏輯逃跑（npc-ai onThreatened → flee）
    if (kind === 'cower' && p.brain && p.brain.onThreatened) p.brain.onThreatened(th);
  }

  // ---- 事件 ----
  function addIncident(x, z, kind) {
    let slot = null;
    for (const s of incidents) {
      // 同一處持續的騷動：沿用原 id、刷新 age（持續打架不會每 INCIDENT_TTL 換新 id 讓同一人反覆擲拍片機率）
      if (s.age < INCIDENT_TTL && Math.hypot(s.x - x, s.z - z) <= INCIDENT_MERGE) {
        s.age = 0;
        return s;
      }
    }
    for (const s of incidents) if (!slot || s.age > slot.age) slot = s;
    slot.id = ++incidentSeq;
    slot.x = x;
    slot.z = z;
    slot.kind = kind;
    slot.age = 0;
    return slot;
  }

  // 每人每事件只反應一次：依 slot 記已看過的 id（slot 繞回後 id 順序 ≠ slot 順序，不能用高水位）
  function checkIncidents(p, a) {
    for (let i = 0; i < INCIDENT_SLOTS; i++) {
      const s = incidents[i];
      if (s.age >= INCIDENT_TTL || s.id === a.incSeen[i]) continue;
      a.incSeen[i] = s.id;
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      // 槍擊：GUNSHOT_RADIUS 內大腦會逃跑，只有外圈的人拍
      const rMin = s.kind === 'gunshot' ? Math.max(FILM_MIN_DIST, GUNSHOT_RADIUS) : FILM_MIN_DIST;
      const rMax = s.kind === 'gunshot' ? FILM_RADIUS_GUNSHOT : FILM_RADIUS;
      if (d < rMin || d > rMax || a.act === 'film') continue;
      // 每人每事件固定一次（id 雜湊），不吃活動亂數序列
      const roll = (seedFromId(s.id, a.hashBase) >>> 8) / 16777216;
      if (roll < FILM_CHANCE) {
        startFilm(p, a, s);
        return;
      }
    }
  }

  // ---- 對外 ----
  function attach(p) {
    const a = p.amb || (p.amb = newRecord());
    const id = p.actor ? p.actor.id : p.slot;
    a.seed = seedFromId(id, seed ^ SALT);
    a.hashBase = (a.seed ^ 0x9e3779b9) >>> 0;
    a.act = null;
    a.t = 0;
    a.group = null;
    a.seat = null;
    a.react = null;
    a.threat = null;
    a.clip = null;
    a.acc = 0;
    a.cool = rnd(a) * COOLDOWN_MAX; // 剛出現的人錯開開始時間
    a.cowerCool = 0;
    a.shoutCool = 0;
    a.meetT = rnd(a) * MEET_EVERY;
    a.waveCool = 0;
    for (let i = 0; i < INCIDENT_SLOTS; i++) a.incSeen[i] = incidents[i].id; // 掛上前已發生的事件不反應
    a.glared = false;
    a.hot = 0;
    p.pace = 1;
    p.faceHold = null;
    if (p.anim && p.anim.setAmbient) p.anim.setAmbient(null);
    if (p.brain) p.brain.filmChance = FILM_CHANCE;
    return a;
  }

  function detach(p) {
    const a = p.amb;
    if (a) {
      if (a.act) endActivity(p, a);
      a.react = null;
      a.threat = null;
      a.clip = null;
    }
    p.pace = 1;
    p.faceHold = null;
    if (p.anim && p.anim.setAmbient) p.anim.setAmbient(null);
    if (bubbles) bubbles.release(p);
  }

  function setContext({ hour, aiming, aimDirX, aimDirZ } = {}) {
    if (Number.isFinite(hour)) ctx.hour = ((hour % 24) + 24) % 24;
    if (aiming !== undefined) ctx.aiming = !!aiming;
    if (Number.isFinite(aimDirX) && Number.isFinite(aimDirZ)) {
      const l = Math.hypot(aimDirX, aimDirZ);
      if (l > 1e-6) {
        ctx.aimDirX = aimDirX / l;
        ctx.aimDirZ = aimDirZ / l;
      }
    }
  }

  // evt：{ type: 'incident', x, z, kind } / { type: 'bump', ped, from? } / { type: 'aim', ped, from? }（from 省略 = 玩家）
  let lastT = null;
  function notify(evt) {
    if (!evt) return false;
    if (evt.type === 'incident') {
      if (!Number.isFinite(evt.x) || !Number.isFinite(evt.z)) return false;
      addIncident(evt.x, evt.z, evt.kind || 'fight');
      return true;
    }
    const p = evt.ped;
    const a = p && p.amb;
    const from = evt.from || (lastT && lastT.context && lastT.context.player) || null;
    if (!a || !from) return false;
    if (evt.type === 'bump') return startShout(p, a, from);
    if (evt.type === 'aim') return startCower(p, a, from);
    return false;
  }

  // 每幀：t = { peds, frame, stagger: { shouldTick }, context: { player, playerInVehicle } }
  function update(t, simDt) {
    lastT = t;
    const peds = t.peds;
    const frame = t.frame;
    const st = t.stagger;
    for (const s of incidents) s.age += simDt;
    // 玩家水平速度：以模擬秒數除位移（沒有推進的幀沿用上次）
    const pa = t.context && t.context.player;
    const inCar = !!(t.context && t.context.playerInVehicle);
    if (pa && pa.pos) {
      player.acc += simDt;
      if (inCar) {
        // 開車時 actor.pos 停在上車點（駕駛位置在車上）：不估速度，下車後重新取樣
        player.have = false;
        player.speed = 0;
      } else if (!player.have) {
        player.x = pa.pos.x;
        player.z = pa.pos.z;
        player.have = true;
        player.speed = 0;
        player.acc = 0;
      } else if (player.acc > 0.03) {
        const v = Math.hypot(pa.pos.x - player.x, pa.pos.z - player.z) / player.acc;
        // 下車 / 瞬移（位移超過 PLAYER_TELEPORT_SPEED）：只重設前一位置，不當成衝刺
        player.speed = v > PLAYER_TELEPORT_SPEED ? 0 : v;
        player.x = pa.pos.x;
        player.z = pa.pos.z;
        player.acc = 0;
      }
    }
    // 計數（缺額控制用）
    cnt[0] = cnt[1] = act[0] = act[1] = 0;
    for (const p of peds) {
      const a = p.amb;
      if (!a) continue;
      a.hot = hotAt(p.x, p.z);
      if (!p.brain || p.brain.state !== 'wander' || a.react) continue;
      if (p.state !== 'walk' && !a.act) continue;
      cnt[a.hot]++;
      if (a.act) act[a.hot]++;
    }
    stats.eligible = cnt[0] + cnt[1];
    stats.active = act[0] + act[1];
    const aimOn = ctx.aiming && pa && !inCar;
    const bumpOn = pa && !inCar && player.speed > BUMP_SPEED;
    for (const p of peds) {
      const a = p.amb;
      if (!a) continue;
      a.acc += simDt;
      if (aimOn || bumpOn) {
        const dx = p.x - pa.pos.x;
        const dz = p.z - pa.pos.z;
        if (bumpOn && dx * dx + dz * dz <= BUMP_DIST * BUMP_DIST) startShout(p, a, pa);
        else if (aimOn && dx * dx + dz * dz <= AIM_RANGE * AIM_RANGE) {
          const along = dx * ctx.aimDirX + dz * ctx.aimDirZ;
          if (along > 0 && Math.abs(dx * ctx.aimDirZ - dz * ctx.aimDirX) <= AIM_LATERAL) startCower(p, a, pa);
        }
      }
      const level = p.citizen ? p.citizen.level : 'near';
      if (level === 'far') continue;
      if (!st.shouldTick(p.slot, frame, level === 'near' ? EVERY_NEAR : EVERY_MID)) continue;
      const dt = a.acc;
      a.acc = 0;
      tickPed(p, a, dt, peds);
    }
  }

  function tickPed(p, a, dt, peds) {
    a.cowerCool -= dt;
    a.shoutCool -= dt;
    a.waveCool -= dt;
    const b = p.brain;
    if (!b) return;
    if (b.state !== 'wander') {
      // 大腦接手（逃跑 / 打架 / 圍觀 / 喇叭…）：活動與反應取消；只做動畫對應
      if (a.act) endActivity(p, a);
      if (a.react) {
        a.react = null;
        a.threat = null;
      }
      p.pace = 1;
      p.faceHold = null;
      if (b.state === 'glare' && !a.glared) {
        a.glared = true;
        gesture(p, 'angry_shout');
      }
      setClip(p, a, b.state === 'look' ? 'look_around' : b.state === 'watch' && b.filming ? 'phone_film' : null);
      return;
    }
    a.glared = false;
    if (a.react) {
      a.reactT += dt;
      if (a.reactT >= a.reactDur) finishReact(p, a);
      return;
    }
    if (p.state !== 'walk' || p.pendingFrom) {
      // 走回路線 / 起身中 / 被拖出待起身：不排活動
      if (a.act) endActivity(p, a);
      setClip(p, a, null);
      return;
    }
    if (a.clip && !a.act) setClip(p, a, null); // 大腦剛交還漫步：清掉 look_around / phone_film
    checkIncidents(p, a);
    if (a.act) {
      updateActivity(p, a, dt);
      return;
    }
    a.cool -= dt;
    a.meetT -= dt;
    if (a.meetT <= 0) {
      a.meetT += MEET_EVERY;
      if (a.meetT <= 0) a.meetT = MEET_EVERY;
      meet(p, a, peds);
      if (a.act) return;
    }
    if (a.cool > 0) return;
    const k = a.hot;
    if (act[k] >= targetRatio(ctx.hour, !!k) * cnt[k]) return;
    if (rnd(a) >= 1 - Math.exp(-START_RATE * dt)) return;
    chooseActivity(p, a);
  }

  return {
    attach,
    detach,
    update,
    updateBubbles(dt) {
      if (bubbles) bubbles.update(dt);
    },
    notify,
    setContext,
    setSeats(list = []) {
      for (const s of seatList) if (s.by && s.by.amb) endActivity(s.by, s.by.amb);
      seatList = list.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw || 0, by: null }));
    },
    setHotspots(list = []) {
      hot = list.slice();
    },
    // 直接開始指定活動（除錯 / 任務演出 / 測試）：'phone_talk' | 'phone_text' | 'look_around' | 'chat' | 'jog' | 'sit'；
    // 只對漫步中（brain wander、ped walk、無反應中）者有效，會先結束目前活動；回傳是否開始
    start(p, name) {
      const a = p.amb;
      if (!a || a.react || !p.brain || p.brain.state !== 'wander' || p.state !== 'walk' || p.pendingFrom) return false;
      if (a.act) endActivity(p, a);
      if (name === 'phone_talk' || name === 'phone_text') {
        startPhone(p, a);
        if (a.act !== name) {
          a.act = name;
          setClip(p, a, name);
        }
      } else if (name === 'look_around') startLook(p, a);
      else if (name === 'chat') return startChat(p, a);
      else if (name === 'jog') startJog(p, a);
      else if (name === 'sit') {
        const s = seatNear(p);
        if (!s) return false;
        startSit(p, a, s);
      } else return false;
      return true;
    },
    activityOf(p) {
      return p.amb ? p.amb.react || p.amb.act : null;
    },
    get context() {
      return ctx;
    },
    groups,
    incidents,
    stats,
    bubbles,
  };
}
