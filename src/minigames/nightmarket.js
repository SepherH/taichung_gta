// P21 夜市攤位小遊戲（射氣球、彈珠台）：夜市角頭地盤（新光三越．大遠百商圈）惠來路二段西側人行道固定 2 攤，
//   各有門口小光柱（BEACON_COLORS.minigame，由整合層傳入色碼）與地圖標記 kind 'minigame'（marker-colors #00b8d4、小地圖「玩」字圖示）
// 純邏輯不 import three：3D 外觀 createNightMarketView({ THREE, … }) 注入 THREE；DOM（彈珠台面板 / 射氣球狀態條）只在給 doc 時建立（node 測試省略）
//
// 點位（世界座標 X 東、Z 南，m；yaw 前方 = (sin yaw, cos yaw) = 從人行道背離道路、朝攤位內側）：
//   夜市外送取餐點 NIGHT_MARKET_DELIVERY.pickup (557.2, −125.1) 所在的惠來路二段（路寬 12.8 m）中心線最近點 (564.27, −120.67)，
//   沿道路方向 ∓16 m、往取餐點那側（西側空地）退到路緣外 3.6 m（中心線 10 m）= 玩家站位；攤位本體往內側延伸 ≤ 4 m（不壓建築、不上車道 / 步道）
//   P21 修正：站位離任一車道中心線 ≥ 垃圾車車道偏移 1.8 + 投入口 DUMP_RADIUS 5 + MINIGAME_RADIUS 2.5（互動範圍不與路過的垃圾車重疊），
//   離委託 / 打工起點（外送取餐點、夜市跑單攤 stallBack、泊車亭、新光三越委託起點觸發圈）≥ 12 m；站位半徑內攤位提示壓過 priority ≤ MINIGAME_OVERRIDE_PRIORITY 3
//   既有攤位道具（job-props.js stallRow：原攤車 + oyster / tea 沿路緣 ±2.72 m）在 ±3.9 m 內，兩攤與之相距 ≥ 12 m（不重疊、不搶外送取餐 12 m 半徑）
//   tools/test/p21-nightmarket.mjs 以 osm-city.json 重驗（夜市角頭地盤內、地圖內、不在建築 / 車道 / 水面、不與既有攤位重疊）
//
// 射氣球（balloon）：付 BALLOON_PRICE NT$50 → 自動換手槍（無限備彈）→ 攤位後方 5 × 3 氣球牆（InstancedMesh 一個 draw call）；
//   BALLOON_SHOTS 10 發（只算手槍；每發 weapon:fire 都扣），子彈穿透氣球：射線 BALLOON_HIT_R 內的氣球全破（瞄兩顆中間可一槍兩顆）；
//   破 ≥ BALLOON_WIN 12 顆得 NT$300、全破 15 顆 NT$800；10 發用完或全破 → 下一次 update 結算
//   豁免只對「局中 + 攤位武器 BALLOON_WEAPON 手槍 + 槍口離站位 ≤ BALLOON_AIM_DIST 12 m + 射線與攤位正面夾角 ≤ BALLOON_AIM_DEG 30° 且穿過氣球牆寬度」：
//   exemptShot(e)（weapon:fire payload）= true → 整合層不報 gunfire；shieldShots(origin, dir)（raycast 參數，另驗 getWeapon()）= true → raycast 不回傳行人；
//   其他武器 / 朝攤位外的射擊照常報 gunfire、不遮蔽行人，且不算 10 發；局中換成非攤位武器（weapon:equip）、用其他武器開火、或連續 BALLOON_FOUL_SHOTS 3 發朝外 → 結束 foul（不退費）
// 彈珠台（pachinko）：付 PACHINKO_PRICE NT$30 → 開 DOM / canvas 面板（世界暫停）；按住空白鍵 / Enter / 「發射」鈕蓄力、放開發射，
//   珠子從左上發射口水平射出（力道 → 初速），在釘板彈跳（簡化碰撞：推出重疊 + 法向反彈 PEG_RESTITUTION，正上方落下時依列奇偶微推），落入底部 9 格得分；
//   釘子反彈加以局為種子的隨機偏移（PEG_JITTER；seed = 開局時間 ⊕ 局數，createNightMarket({ pachinkoSeed }) 可注入固定 seed，同 seed 可重現）；
//   3 顆總分 ≥ PACHINKO_WIN 180 得 NT$200；3 顆全落最高格（100 分，總分 300）改得 NT$500（不累加）；
//   均勻隨機力道 2000 局模擬期望獎金 ≈ NT$11 < 票價 30、NT$500 機率 ≈ 0.1%（最佳固定力道期望 ≈ NT$22，仍 < 30；測試 p21-nightmarket 斷言）
// 互斥：isBusy()（任務 / 副任務 / 其他活動）→ 拒絕並 toast；通緝 ≥ 1 星 → 拒絕並 toast WANTED_TEXT「先甩掉警察」（先判通緝）；錢不夠 → toast、不開局
// 結束：玩完 → 結算（獎金 earn(n, 'minigame')、更新最佳成績）；玩中 Esc（射氣球 = 暫停選單 game:pause；彈珠台 = 面板 Esc）/ 走遠 > LEAVE_DIST 8 m /
//   上車 / 倒地 / 局中被通緝 / 違規（foul）→ 結束不退費（reward 0、不記最佳）；回主選單 / 開新局 cancel() → 無聲收場（不發事件、不退費）
//   game:pause：最後一發已打完（bal.done：10 發用完或全破）→ 先正常結算（done）；整合層在滑鼠鎖定失效（切視窗）自動暫停前呼叫 setAutoPause(true)
//   → 該次暫停不視為放棄（局保留、繼續後照玩），呼叫後 setAutoPause(false)
// 存檔：serialize() → { balloon: { best }, pachinko: { best } }（兩項皆 0 → null，存檔省略）；restore(rec)（src/save.js 清洗，舊存檔無此欄 → 0）
// 事件（bus）：minigame:start { id, price } / minigame:end { id, score, reward, reason: 'done'|'esc'|'left'|'wanted'|'foul', best, newBest }
//   ui:sound { kind: 'click' }（氣球破）/ { kind: 'reward'|'fail' }（結算）；訂閱 weapon:fire（射氣球命中判定：槍口 x, y, z + dirX/Y/Z 射線對氣球球體，落點 ex, ey, ez 之後的不算）、
//   game:pause（射氣球 Esc）、weapon:equip（局中換武器 → foul）
// 每幀路徑（nearest / update / updatePanel / markers / exemptShot / shieldShots）不配置新物件

export const MINIGAME_IDS = Object.freeze(['balloon', 'pachinko']);
export const MINIGAME_KIND = 'minigame'; // 地圖標記 kind
export const MINIGAME_PRIORITY = 2; // interactable 仲裁級別（同武器店 / 安全屋；委託 3 優先，同級取近）
export const MINIGAME_OVERRIDE_PRIORITY = 3; // 站位 MINIGAME_RADIUS 內：攤位提示壓過 priority ≤ 3（委託 / 外送 / 打工 / 垃圾車）；故事對白等更高者不壓
export const MINIGAME_RADIUS = 2.5; // 互動半徑（m，玩家站位周圍）
export const LEAVE_DIST = 8; // 玩中離站位超過此距離（m）→ 結束不退費
export const MINIGAME_BEACON = { height: 7, radius: 0.7, sink: 1 }; // 門口小光柱尺寸（同武器店）
export const WANTED_TEXT = '老闆：「你被通緝了，先甩掉警察再來玩！」';
export const BUSY_TEXT = '任務進行中，不能玩夜市小遊戲';

// ---------- 攤位點位 ----------
export const BOOTHS = Object.freeze([
  Object.freeze({ id: 'balloon', name: '夜市射氣球', x: 547.3, z: -112.42, yaw: -2.13, price: 50, road: '惠來路二段' }),
  Object.freeze({ id: 'pachinko', name: '夜市彈珠台', x: 564.29, z: -139.54, yaw: -2.13, price: 30, road: '惠來路二段' }),
]);

// ---------- 射氣球規則 ----------
export const BALLOON_PRICE = 50;
export const BALLOON_COLS = 5;
export const BALLOON_ROWS = 3;
export const BALLOON_COUNT = BALLOON_COLS * BALLOON_ROWS;
export const BALLOON_SHOTS = 10;
export const BALLOON_WIN = 12; // 破 ≥ 12 顆
export const BALLOON_REWARD = 300;
export const BALLOON_ALL_REWARD = 800; // 全破
export const BALLOON_SPACING = 0.45; // 相鄰氣球中心距（m）
export const BALLOON_RADIUS = 0.22; // 外觀半徑（m）
export const BALLOON_HIT_R = 0.3; // 命中半徑（m，含子彈粗細；> 半間距 0.225 → 瞄兩顆中間一槍兩顆，< 對角 0.318 → 一槍最多兩顆）
export const BALLOON_WALL_Z = 3.65; // 氣球牆離站位（攤位本地 +Z，m）
export const BALLOON_BASE_Y = 1.2; // 最下排離地高（m）
export const BALLOON_WEAPON = 'pistol'; // 攤位武器（開局 equipPistol；只有它的射擊算發數 / 豁免）
export const BALLOON_AIM_DEG = 30; // 豁免：射線與攤位正面（本地 +Z）夾角上限
export const BALLOON_AIM_DIST = 12; // 豁免：槍口離站位上限（m）
export const BALLOON_WALL_HALF = 1.5; // 豁免：射線在氣球牆平面（本地 z = BALLOON_WALL_Z）的左右偏移上限（m，= 後牆半寬）
export const BALLOON_FOUL_SHOTS = 3; // 局中連續朝攤位外開槍幾發 → 結束 foul

// 射氣球獎金（純函式）：全破 800、≥ 12 顆 300、其餘 0
export function balloonReward(popped) {
  const n = Math.max(0, Math.floor(Number(popped) || 0));
  if (n >= BALLOON_COUNT) return BALLOON_ALL_REWARD;
  if (n >= BALLOON_WIN) return BALLOON_REWARD;
  return 0;
}

// 攤位本地 → 世界（右 = (cos yaw, −sin yaw)、前 = (sin yaw, cos yaw)）
function localToWorld(b, lx, lz, out) {
  const s = Math.sin(b.yaw);
  const c = Math.cos(b.yaw);
  out.x = b.x + c * lx + s * lz;
  out.z = b.z - s * lx + c * lz;
  return out;
}

// 氣球中心（世界座標）：第 i 顆 = row * COLS + col；col 0 在攤位左側（本地 −X）、row 0 最下排；out 陣列重用（每顆 { x, y, z }）
export function balloonCenters(booth, groundY = 0, out = []) {
  const p = { x: 0, z: 0 };
  for (let r = 0; r < BALLOON_ROWS; r++) {
    for (let c = 0; c < BALLOON_COLS; c++) {
      const i = r * BALLOON_COLS + c;
      localToWorld(booth, (c - (BALLOON_COLS - 1) / 2) * BALLOON_SPACING, BALLOON_WALL_Z, p);
      const o = out[i] || (out[i] = { x: 0, y: 0, z: 0 });
      o.x = p.x;
      o.y = groundY + BALLOON_BASE_Y + r * BALLOON_SPACING;
      o.z = p.z;
    }
  }
  out.length = BALLOON_COUNT;
  return out;
}

// 射線對氣球（純函式）：o = 起點、d = 方向（不必正規化）、maxT = 射線長（落點距離；Infinity = 打空）；
//   alive[i] 為真者才算；命中者寫入 hits（重用陣列，回傳命中數）；子彈穿透：射線 r 內的全部命中
export function rayBalloonHits(ox, oy, oz, dx, dy, dz, maxT, centers, alive, hits = [], r = BALLOON_HIT_R) {
  hits.length = 0;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) return 0;
  const fx = dx / len;
  const fy = dy / len;
  const fz = dz / len;
  const lim = Number.isFinite(maxT) ? maxT + r : Infinity;
  for (let i = 0; i < centers.length; i++) {
    if (alive && !alive[i]) continue;
    const c = centers[i];
    const vx = c.x - ox;
    const vy = c.y - oy;
    const vz = c.z - oz;
    const t = vx * fx + vy * fy + vz * fz;
    if (t <= 0 || t > lim) continue;
    const d2 = vx * vx + vy * vy + vz * vz - t * t;
    if (d2 <= r * r) hits.push(i);
  }
  return hits.length;
}

// ---------- 彈珠台規則（2D 板面座標：x 右、y 下，單位 = 面板像素）----------
export const PACHINKO_PRICE = 30;
export const PACHINKO_BALLS = 3;
export const PACHINKO_WIN = 180; // 3 顆總分門檻（P21 修正：150 → 180，均勻隨機力道期望獎金 < 票價）
export const PACHINKO_REWARD = 200;
export const PACHINKO_JACKPOT_REWARD = 500; // 3 顆全落入最高格
export const BOARD_W = 300;
export const BOARD_H = 400;
export const BALL_R = 6;
export const PEG_R = 4;
export const PEG_RESTITUTION = 0.45;
export const WALL_RESTITUTION = 0.6;
export const GRAVITY = 600; // 板面單位 / s²
export const LAUNCH = { x: 20, y: 40, vMin: 60, vMax: 520 }; // 發射口與水平初速範圍（力道 0 → vMin、1 → vMax）
export const CHARGE_RATE = 0.8; // 蓄力速度（力道 / s，1.25 s 滿）
export const POWER_MIN = 0.05;
export const SLOT_SCORES = Object.freeze([10, 30, 50, 20, 100, 20, 50, 30, 10]);
export const SLOT_TOP = 350; // 格子上緣（隔板頂）
export const SLOT_LAND_Y = 362; // 珠心到此高度即判定落格
export const PACHINKO_MAX_SCORE = PACHINKO_BALLS * Math.max(...SLOT_SCORES);
export const SIM_STEP = 1 / 240; // 固定子步（s）
export const PEG_JITTER = 0.9; // 釘子反彈法向隨機旋轉幅度（rad，±一半）；rng 為 null 時不偏移（純函式測試用）
export const BALL_TIMEOUT = 15; // 單顆最長模擬秒數（卡住保底：以當下 x 落格）

// 釘子：8 列，偶數列 7 根（x 30–270）、奇數列 6 根（x 50–250），列距 30
export const PEGS = Object.freeze((() => {
  const out = [];
  for (let r = 0; r < 8; r++) {
    const y = 110 + r * 30;
    const n = r % 2 === 0 ? 7 : 6;
    const x0 = r % 2 === 0 ? 30 : 50;
    for (let k = 0; k < n; k++) out.push(Object.freeze({ x: x0 + k * 40, y, row: r }));
  }
  return out;
})());

export function launchSpeed(power) {
  const p = Math.min(1, Math.max(POWER_MIN, Number(power) || 0));
  return LAUNCH.vMin + (LAUNCH.vMax - LAUNCH.vMin) * p;
}

// 蓄力（純函式）：按住 dt 秒後的力道，上限 1
export function chargePower(power, dt, rate = CHARGE_RATE) {
  return Math.min(1, Math.max(0, (Number(power) || 0) + Math.max(0, dt) * rate));
}

export function slotAt(x) {
  const n = SLOT_SCORES.length;
  return Math.min(n - 1, Math.max(0, Math.floor((x / BOARD_W) * n)));
}

// 彈珠台獎金（純函式）：3 顆全落入最高格 → 500；否則總分 ≥ 180 → 200；其餘 0
export function pachinkoReward(scores) {
  const top = Math.max(...SLOT_SCORES);
  let total = 0;
  let tops = 0;
  for (const s of scores || []) {
    const v = Number(s) || 0;
    total += v;
    if (v >= top) tops++;
  }
  if (tops >= PACHINKO_BALLS) return PACHINKO_JACKPOT_REWARD;
  return total >= PACHINKO_WIN ? PACHINKO_REWARD : 0;
}

// 可重現亂數（mulberry32）：同 seed 同序列；回傳 () => [0, 1)
export function createRng(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createBall() {
  return { x: LAUNCH.x, y: LAUNCH.y, vx: 0, vy: 0, t: 0, active: false, bounces: 0, slot: -1 };
}

export function launchBall(ball, power) {
  ball.x = LAUNCH.x;
  ball.y = LAUNCH.y;
  ball.vx = launchSpeed(power);
  ball.vy = 0;
  ball.t = 0;
  ball.bounces = 0;
  ball.slot = -1;
  ball.active = true;
  return ball;
}

// 單一子步（純函式，原地改 ball）：重力 → 移動 → 左右牆 → 釘子（推出 + 法向反彈，rng 給了 → 反彈法向隨機偏移）→ 格子隔板 → 落格判定；回傳落入的格子索引或 -1
export function pachinkoStep(ball, h = SIM_STEP, rng = null) {
  if (!ball.active) return -1;
  ball.t += h;
  ball.vy += GRAVITY * h;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  if (ball.x < BALL_R) {
    ball.x = BALL_R;
    if (ball.vx < 0) ball.vx = -ball.vx * WALL_RESTITUTION;
  } else if (ball.x > BOARD_W - BALL_R) {
    ball.x = BOARD_W - BALL_R;
    if (ball.vx > 0) ball.vx = -ball.vx * WALL_RESTITUTION;
  }
  if (ball.y < BALL_R) {
    ball.y = BALL_R;
    if (ball.vy < 0) ball.vy = 0;
  }
  const rr = BALL_R + PEG_R;
  for (let i = 0; i < PEGS.length; i++) {
    const p = PEGS[i];
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    if (dx > rr || dx < -rr || dy > rr || dy < -rr) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) continue;
    const d = Math.sqrt(d2) || 1e-6;
    let nx = dx / d;
    let ny = dy / d;
    // 簡化規則：幾乎正上方落下（|nx| < 0.05）→ 依列奇偶往左 / 右微推，不會停在釘子頂上
    if (Math.abs(nx) < 0.05 && ny < 0) {
      nx = p.row % 2 === 0 ? 0.3 : -0.3;
      ny = -Math.sqrt(1 - nx * nx);
    }
    ball.x = p.x + nx * rr;
    ball.y = p.y + ny * rr;
    let vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0 && rng) {
      // 以局為種子的隨機偏移：反彈法向旋轉 ±PEG_JITTER / 2 rad（同 seed 可重現；力道不再決定落格）
      const a = (rng() - 0.5) * PEG_JITTER;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = nx * ca - ny * sa;
      ny = nx * sa + ny * ca;
      nx = rx;
      vn = ball.vx * nx + ball.vy * ny;
      if (vn >= 0) vn = -1e-3;
    }
    if (vn < 0) {
      ball.vx -= (1 + PEG_RESTITUTION) * vn * nx;
      ball.vy -= (1 + PEG_RESTITUTION) * vn * ny;
      ball.bounces++;
    }
  }
  // 格子隔板（x = 每格邊界，SLOT_TOP 以下）：視為垂直牆
  if (ball.y > SLOT_TOP) {
    const w = BOARD_W / SLOT_SCORES.length;
    const k = Math.round(ball.x / w);
    if (k > 0 && k < SLOT_SCORES.length) {
      const wx = k * w;
      const dx = ball.x - wx;
      if (Math.abs(dx) < BALL_R) {
        ball.x = wx + (dx >= 0 ? BALL_R : -BALL_R);
        ball.vx = -ball.vx * WALL_RESTITUTION;
      }
    }
  }
  if (ball.y >= SLOT_LAND_Y || ball.t >= BALL_TIMEOUT) {
    ball.active = false;
    ball.slot = slotAt(ball.x);
    return ball.slot;
  }
  return -1;
}

// 整顆模擬（純函式，測試 / 預覽用）：力道（+ 選填 rng）→ { slot, score, bounces, time }；同 rng 序列結果可重現
export function simulatePachinko(power, ball = createBall(), rng = null) {
  launchBall(ball, power);
  let slot = -1;
  while (slot < 0) slot = pachinkoStep(ball, SIM_STEP, rng);
  return { slot, score: SLOT_SCORES[slot], bounces: ball.bounces, time: ball.t };
}

// ---------- 開局資格（純函式）----------
// ctx = { stars, busy（字串 | null）, money }；回 { ok, reason: 'wanted'|'busy'|'money'|null, text }
export function checkPlay(booth, ctx) {
  if (!booth) return { ok: false, reason: 'unknown', text: '' };
  if ((Number(ctx.stars) || 0) >= 1) return { ok: false, reason: 'wanted', text: WANTED_TEXT };
  if (ctx.busy) return { ok: false, reason: 'busy', text: typeof ctx.busy === 'string' ? ctx.busy : BUSY_TEXT };
  if (!((Number(ctx.money) || 0) >= booth.price)) return { ok: false, reason: 'money', text: `錢不夠：${booth.name} NT$${booth.price}` };
  return { ok: true, reason: null, text: '' };
}

// 最佳成績清洗（與 src/save.js minigamesRecord 同規則；測試交叉比對）
export function minigameRecord(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const pick = (o, max) => {
    const b = o && typeof o === 'object' ? o.best : undefined;
    return Number.isInteger(b) && b > 0 ? Math.min(max, b) : 0;
  };
  const balloon = pick(src.balloon, BALLOON_COUNT);
  const pachinko = pick(src.pachinko, PACHINKO_MAX_SCORE);
  if (!balloon && !pachinko) return null;
  return { balloon: { best: balloon }, pachinko: { best: pachinko } };
}

// ---------- 攤位外觀 / 碰撞（攤位本地：lx 右、ly 底高、lz 前；w / h / d = 寬 / 高 / 深）----------
const BOOTH_PARTS = {
  balloon: [
    { lx: 0, ly: 0, lz: 0.8, w: 2.6, h: 1.0, d: 0.5, color: 0x8d5a2b, solid: true }, // 櫃台
    { lx: 0, ly: 0, lz: 3.9, w: 3.0, h: 3.0, d: 0.2, color: 0xf5f0e1, solid: true }, // 後牆（擋子彈）
    { lx: -1.45, ly: 0, lz: 2.35, w: 0.1, h: 2.8, d: 3.1, color: 0xc62828, solid: true }, // 左側板
    { lx: 1.45, ly: 0, lz: 2.35, w: 0.1, h: 2.8, d: 3.1, color: 0xc62828, solid: true }, // 右側板
    { lx: 0, ly: 2.8, lz: 2.3, w: 3.2, h: 0.12, d: 3.6, color: 0xffd54f }, // 頂棚
    { lx: 0, ly: 2.95, lz: 0.55, w: 2.4, h: 0.5, d: 0.08, color: 0xd32f2f }, // 招牌
  ],
  pachinko: [
    { lx: 0, ly: 0, lz: 1.2, w: 1.0, h: 1.9, d: 0.6, color: 0x283593, solid: true }, // 彈珠台機台
    { lx: 0, ly: 0.7, lz: 0.88, w: 0.8, h: 1.0, d: 0.04, color: 0xe0e0e0 }, // 機台玻璃面
    { lx: 0, ly: 2.05, lz: 1.2, w: 1.4, h: 0.4, d: 0.08, color: 0xff6f00 }, // 招牌
    { lx: -0.95, ly: 0, lz: 0.3, w: 0.08, h: 2.6, d: 0.08, color: 0x6d4c41 }, // 棚柱 ×4
    { lx: 0.95, ly: 0, lz: 0.3, w: 0.08, h: 2.6, d: 0.08, color: 0x6d4c41 },
    { lx: -0.95, ly: 0, lz: 1.9, w: 0.08, h: 2.6, d: 0.08, color: 0x6d4c41 },
    { lx: 0.95, ly: 0, lz: 1.9, w: 0.08, h: 2.6, d: 0.08, color: 0x6d4c41 },
    { lx: 0, ly: 2.6, lz: 1.1, w: 2.1, h: 0.1, d: 2.0, color: 0xffd54f }, // 頂棚
  ],
};
const BEACON_LZ = { balloon: 4.4, pachinko: 2.2 }; // 小光柱位置（攤位本地 +Z：後牆 / 機台後方，不擋視線）

export function boothParts(id) {
  return BOOTH_PARTS[id] || [];
}

// 攤位占地（世界座標四角，xz）：所有部件外接矩形；測試驗不壓建築 / 車道、不與既有攤位重疊
export function boothFootprint(booth) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of boothParts(booth.id)) {
    x0 = Math.min(x0, p.lx - p.w / 2);
    x1 = Math.max(x1, p.lx + p.w / 2);
    z0 = Math.min(z0, p.lz - p.d / 2);
    z1 = Math.max(z1, p.lz + p.d / 2);
  }
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([lx, lz]) => localToWorld(booth, lx, lz, { x: 0, z: 0 }));
}

export function beaconPoint(booth) {
  return localToWorld(booth, 0, BEACON_LZ[booth.id] || 0, { x: 0, z: 0 });
}

// 靜態碰撞盒（交給 physics/colliders.js addStaticBox；y = 盒底）：櫃台 / 後牆 / 側板 / 機台
export function boothColliderBoxes(booths = BOOTHS, heightAt = () => 0) {
  const out = [];
  const p = { x: 0, z: 0 };
  for (const b of booths) {
    const gy = Number(heightAt(b.x, b.z)) || 0;
    for (const part of boothParts(b.id)) {
      if (!part.solid) continue;
      localToWorld(b, part.lx, part.lz, p);
      out.push({ x: p.x, y: gy + part.ly, z: p.z, yaw: b.yaw, width: part.w, depth: part.d, height: part.h });
    }
  }
  return out;
}

// ---------- 3D 外觀（THREE 注入）：draw call 共 3 = 攤位合併網格 1 + 氣球 InstancedMesh 1 + 小光柱 InstancedMesh 1（兩攤共用）----------
// 無貼圖、無光源、不投影（castShadow false）；update 只改既有材質 opacity，pop / reset 只改既有矩陣
export function createNightMarketView({ THREE, scene = null, booths = BOOTHS, heightAt = () => 0, beaconColor = 0x00b8d4, beacon = MINIGAME_BEACON } = {}) {
  const ground = booths.map((b) => Number(heightAt(b.x, b.z)) || 0);
  // 攤位：所有方塊合併成一個 BufferGeometry（頂點色）
  const pos = [];
  const nor = [];
  const col = [];
  const color = new THREE.Color();
  const FACES = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const pushBox = (b, gy, part) => {
    color.setHex(part.color);
    const s = Math.sin(b.yaw);
    const c = Math.cos(b.yaw);
    const hw = part.w / 2;
    const hh = part.h / 2;
    const hd = part.d / 2;
    const cy = gy + part.ly + hh;
    const toWorld = (lx, ly, lz) => {
      const X = part.lx + lx;
      const Z = part.lz + lz;
      pos.push(b.x + c * X + s * Z, cy + ly, b.z - s * X + c * Z);
    };
    for (const [fx, fy, fz] of FACES) {
      // 面的兩個切向量（u × v = 法向，逆時針朝外）
      const u = fx !== 0 ? [0, 0, -fx] : fy !== 0 ? [1, 0, 0] : [fz, 0, 0];
      const v = fx !== 0 ? [0, 1, 0] : fy !== 0 ? [0, 0, -fy] : [0, 1, 0];
      const corner = (a, bb) => toWorld(
        (fx * hw) + (u[0] * a + v[0] * bb) * hw,
        (fy * hh) + (u[1] * a + v[1] * bb) * hh,
        (fz * hd) + (u[2] * a + v[2] * bb) * hd,
      );
      for (const [a, bb] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) corner(a, bb);
      const nxw = c * fx + s * fz;
      const nzw = -s * fx + c * fz;
      for (let k = 0; k < 6; k++) {
        nor.push(nxw, fy, nzw);
        col.push(color.r, color.g, color.b);
      }
    }
  };
  booths.forEach((b, i) => {
    for (const part of boothParts(b.id)) pushBox(b, ground[i], part);
  });
  const boothGeo = new THREE.BufferGeometry();
  boothGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  boothGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  boothGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const boothMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  const boothMesh = new THREE.Mesh(boothGeo, boothMat);
  boothMesh.name = 'nightmarket-booths';
  boothMesh.castShadow = false;
  boothMesh.receiveShadow = true;

  // 氣球牆：射氣球攤 15 顆（InstancedMesh + instanceColor）
  const balloonBooth = booths.find((b) => b.id === 'balloon') || null;
  const centers = balloonBooth ? balloonCenters(balloonBooth, ground[booths.indexOf(balloonBooth)]) : [];
  const balloonGeo = new THREE.SphereGeometry(BALLOON_RADIUS, 12, 8);
  const balloonMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0 });
  const balloons = new THREE.InstancedMesh(balloonGeo, balloonMat, BALLOON_COUNT);
  balloons.name = 'nightmarket-balloons';
  balloons.castShadow = false;
  const PALETTE = [0xe53935, 0xffb300, 0x43a047, 0x1e88e5, 0x8e24aa];
  const m4 = new THREE.Matrix4();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < BALLOON_COUNT; i++) {
    color.setHex(PALETTE[(i + Math.floor(i / BALLOON_COLS)) % PALETTE.length]);
    if (balloons.setColorAt) balloons.setColorAt(i, color);
  }
  const shown = new Array(BALLOON_COUNT).fill(false);
  function setBalloon(i, on) {
    if (i < 0 || i >= BALLOON_COUNT || !centers[i] || shown[i] === on) return;
    shown[i] = on;
    if (on) m4.makeTranslation(centers[i].x, centers[i].y, centers[i].z);
    balloons.setMatrixAt(i, on ? m4 : hidden);
    balloons.instanceMatrix.needsUpdate = true;
  }
  function resetBalloons() {
    for (let i = 0; i < BALLOON_COUNT; i++) setBalloon(i, true);
  }
  resetBalloons();
  if (balloons.instanceColor) balloons.instanceColor.needsUpdate = true;
  if (balloons.computeBoundingSphere) balloons.computeBoundingSphere();

  // 小光柱：兩攤共用一個 InstancedMesh（同色同材質一起脈動）
  const beaconGeo = new THREE.CylinderGeometry(beacon.radius, beacon.radius, beacon.height, 20, 1, true);
  beaconGeo.translate(0, beacon.height / 2 - beacon.sink, 0);
  const beaconMat = new THREE.MeshBasicMaterial({
    color: beaconColor,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, booths.length);
  beacons.name = 'nightmarket-beacons';
  beacons.renderOrder = 5;
  booths.forEach((b, i) => {
    const p = beaconPoint(b);
    m4.makeTranslation(p.x, Number(heightAt(p.x, p.z)) || ground[i], p.z);
    beacons.setMatrixAt(i, m4);
  });
  beacons.instanceMatrix.needsUpdate = true;
  if (beacons.computeBoundingSphere) beacons.computeBoundingSphere();

  const meshes = [boothMesh, balloons, beacons];
  if (scene) for (const m of meshes) scene.add(m);
  let time = 0;
  function update(dt) {
    time += dt > 0 ? dt : 0;
    beaconMat.opacity = 0.3 * (0.72 + 0.28 * Math.sin(time * 1.6));
  }
  function dispose() {
    for (const m of meshes) if (m.parent) m.parent.remove(m);
    for (const g of [boothGeo, balloonGeo, beaconGeo]) g.dispose();
    for (const mt of [boothMat, balloonMat, beaconMat]) mt.dispose();
  }
  return { meshes, drawCalls: meshes.length, centers, setBalloon, resetBalloons, update, dispose, boothMesh, balloons, beacons };
}

// ---------- 主模組 ----------
export function createNightMarket({
  bus = null,
  booths = BOOTHS,
  heightAt = () => 0,
  getMoney = () => 0,
  spend = () => false,
  earn = () => 0,
  getStars = () => 0,
  isBusy = () => null,
  equipPistol = () => {},
  getWeapon = null, // () => 目前武器 id（shieldShots 驗攤位武器；未給 = 只驗方向）
  pachinkoSeed = null, // 彈珠台 seed：數字 = 每局固定（測試）、函式 = 每局呼叫取值、null = 開局時間 ⊕ 局數
  toast = null,
  view = null,
  doc = null,
  root = null,
  keyTarget = null,
} = {}) {
  const emit = (n, p) => {
    if (bus) bus.emit(n, p);
  };
  const say = (text, sec = 3) => {
    if (!text) return;
    if (toast) toast(text, sec);
    else emit('toast', { text, seconds: sec });
  };
  const byId = (id) => booths.find((b) => b.id === id) || null;
  const best = { balloon: 0, pachinko: 0 };
  let disposed = false;
  let playing = null; // null | 'balloon' | 'pachinko'
  let booth = null;

  // 射氣球
  const balloonBooth = byId('balloon');
  const centers = balloonBooth ? balloonCenters(balloonBooth, Number(heightAt(balloonBooth.x, balloonBooth.z)) || 0) : [];
  const alive = new Array(BALLOON_COUNT).fill(true);
  const hits = [];
  const bal = { shots: 0, popped: 0, done: false, outward: 0 };
  let autoPause = false; // 整合層：滑鼠鎖定失效自動暫停期間為真（game:pause 不視為放棄）
  // 攤位正面（本地 +Z）在世界的方向與豁免夾角餘弦（建立時算一次）
  const fwdS = balloonBooth ? Math.sin(balloonBooth.yaw) : 0;
  const fwdC = balloonBooth ? Math.cos(balloonBooth.yaw) : 1;
  const AIM_COS = Math.cos((BALLOON_AIM_DEG * Math.PI) / 180);

  // 彈珠台
  const ball = createBall();
  const pa = { balls: 0, scores: [], charging: false, power: 0, finished: false, acc: 0, reward: 0, lastSlot: -1, seed: 0, rng: null };
  let games = 0;

  const inter = { id: '', text: '', dist: 0, priority: MINIGAME_PRIORITY, override: MINIGAME_OVERRIDE_PRIORITY, act: null, booth: null };
  inter.act = () => (inter.booth ? start(inter.booth.id) : false);
  const promptText = (b) => `按 E 玩${b.id === 'balloon' ? '射氣球' : '彈珠台'}（NT$${b.price}）`;
  const markerList = booths.map((b) => ({ x: b.x, z: b.z, kind: MINIGAME_KIND, label: b.name }));
  const statsOut = { minigameBalloonBest: 0, minigamePachinkoBest: 0 };

  // ---------- DOM（選用）----------
  const ui = doc && typeof doc.createElement === 'function' ? buildUi() : null;

  function buildUi() {
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    // 射氣球狀態條（上方中央，HUD 模組 z-index 55）
    const bar = el('div', 'nm-bar');
    bar.hidden = true;
    Object.assign(bar.style, {
      position: 'fixed', top: 'calc(64px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)', zIndex: '55',
      padding: '6px 14px', borderRadius: '16px', background: 'rgba(0, 0, 0, 0.6)', color: '#fff', font: 'bold 15px sans-serif',
      pointerEvents: 'none', whiteSpace: 'nowrap', border: '2px solid #00b8d4',
    });
    // 彈珠台面板（沿用 ms-panel / ms-card 樣式）
    const panel = el('div', 'ms-panel nm-panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const card = el('div', 'ms-card nm-card');
    const body = el('div', 'ms-card-body');
    const kicker = el('div', 'ms-kicker', '夜市小遊戲');
    const title = el('h2', 'ms-card-title', '彈珠台');
    const info = el('div', 'ms-card-client nm-info', '');
    const canvas = el('canvas', 'nm-canvas');
    canvas.width = BOARD_W;
    canvas.height = BOARD_H;
    Object.assign(canvas.style, { display: 'block', margin: '8px auto', width: 'min(300px, 70vw)', height: 'auto', aspectRatio: `${BOARD_W} / ${BOARD_H}`, background: '#14213d', borderRadius: '8px', touchAction: 'none' });
    const meter = el('div', 'nm-meter');
    Object.assign(meter.style, { height: '10px', borderRadius: '5px', background: 'rgba(255,255,255,0.2)', overflow: 'hidden', margin: '4px 0' });
    const fill = el('div', 'nm-meter-fill');
    Object.assign(fill.style, { height: '100%', width: '0%', background: '#00b8d4' });
    meter.appendChild(fill);
    const msg = el('p', 'ms-card-brief nm-msg', '');
    const actions = el('div', 'ms-actions');
    const fire = el('button', 'ms-btn ms-btn-primary nm-fire', '發射（按住蓄力）');
    fire.type = 'button';
    const leave = el('button', 'ms-btn ms-btn-ghost nm-leave', '離開（Esc）');
    leave.type = 'button';
    const stop = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
    };
    const down = (e) => {
      stop(e);
      if (pa.finished) close();
      else pressLaunch();
    };
    const up = (e) => {
      stop(e);
      releaseLaunch();
    };
    for (const t of [fire, canvas]) {
      t.addEventListener('pointerdown', down);
      t.addEventListener('pointerup', up);
      t.addEventListener('pointercancel', up);
      t.addEventListener('pointerleave', up);
    }
    leave.addEventListener('click', (e) => {
      stop(e);
      if (pa.finished) close();
      else quit('esc');
    });
    actions.append(fire, leave);
    body.append(kicker, title, info, canvas, meter, msg, actions);
    card.appendChild(body);
    panel.appendChild(card);
    const host = root || doc.body;
    host.append(bar, panel);
    const g = canvas.getContext ? canvas.getContext('2d') : null;
    return { bar, panel, info, canvas, g, fill, msg, fire, leave, barText: '', infoText: '', msgText: '', fillPct: -1 };
  }

  const setText = (key, node, text) => {
    if (!ui || ui[key] === text) return;
    ui[key] = text;
    node.textContent = text;
  };

  const SLOT_LABELS = SLOT_SCORES.map(String);
  function drawBoard() {
    if (!ui || !ui.g) return;
    const g = ui.g;
    g.fillStyle = '#14213d';
    g.fillRect(0, 0, BOARD_W, BOARD_H);
    const n = SLOT_SCORES.length;
    const w = BOARD_W / n;
    const top = Math.max(...SLOT_SCORES);
    for (let i = 0; i < n; i++) {
      g.fillStyle = SLOT_SCORES[i] >= top ? '#ff6f00' : i === pa.lastSlot ? '#00b8d4' : '#22335a';
      g.fillRect(i * w + 1, SLOT_TOP, w - 2, BOARD_H - SLOT_TOP);
      g.fillStyle = '#fff';
      g.font = 'bold 12px sans-serif';
      g.textAlign = 'center';
      g.fillText(SLOT_LABELS[i], i * w + w / 2, BOARD_H - 14);
    }
    g.fillStyle = '#d0d4dc';
    for (let i = 0; i < PEGS.length; i++) {
      g.beginPath();
      g.arc(PEGS[i].x, PEGS[i].y, PEG_R, 0, Math.PI * 2);
      g.fill();
    }
    // 發射口 + 力道指示
    g.fillStyle = '#ffd54f';
    g.fillRect(0, LAUNCH.y - 8, LAUNCH.x, 16);
    if (pa.charging) {
      g.fillStyle = 'rgba(0, 184, 212, 0.8)';
      g.fillRect(LAUNCH.x, LAUNCH.y - 2, pa.power * 120, 4);
    }
    if (ball.active || pa.charging) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(ball.active ? ball.x : LAUNCH.x, ball.active ? ball.y : LAUNCH.y, BALL_R, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 文字只在數值變化時重組（每幀不配置字串）；畫布在面板開著時每幀重畫
  let barKey = -1;
  let infoKey = -1;
  function refreshUi() {
    if (!ui) return;
    if (playing === 'balloon') {
      const k = bal.shots * 100 + bal.popped;
      if (k !== barKey) {
        barKey = k;
        setText('barText', ui.bar, `射氣球｜剩 ${BALLOON_SHOTS - bal.shots} 發｜破 ${bal.popped} / ${BALLOON_COUNT}｜≥ ${BALLOON_WIN} 顆 NT$${BALLOON_REWARD}、全破 NT$${BALLOON_ALL_REWARD}｜Esc 或走遠結束`);
      }
      ui.bar.hidden = false;
    } else {
      barKey = -1;
      ui.bar.hidden = true;
    }
    if (playing === 'pachinko') {
      let total = 0;
      for (let i = 0; i < pa.scores.length; i++) total += pa.scores[i];
      const k = pa.balls * 10000 + total;
      if (k !== infoKey) {
        infoKey = k;
        setText('infoText', ui.info, `剩 ${PACHINKO_BALLS - pa.balls} 顆｜總分 ${total}｜≥ ${PACHINKO_WIN} 分 NT$${PACHINKO_REWARD}、最高格 NT$${PACHINKO_JACKPOT_REWARD}`);
      }
      const pct = Math.round(pa.power * 100);
      if (pct !== ui.fillPct) {
        ui.fillPct = pct;
        ui.fill.style.width = `${pct}%`;
      }
      drawBoard();
    } else infoKey = -1;
  }

  // ---------- 鍵盤（彈珠台面板開啟時）----------
  function onKey(e) {
    if (playing !== 'pachinko' || !e) return;
    const code = e.code || e.key;
    let handled = true;
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      if (!e.repeat) {
        if (pa.finished) close();
        else pressLaunch();
      }
    } else if (code === 'Escape' || code === 'Esc') {
      if (pa.finished) close();
      else quit('esc');
    } else handled = false;
    if (!handled) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function onKeyUp(e) {
    if (playing !== 'pachinko' || !e) return;
    const code = e.code || e.key;
    if (code !== 'Space' && code !== 'Enter' && code !== 'NumpadEnter') return;
    releaseLaunch();
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  const keyHost = keyTarget || (ui ? doc.defaultView || globalThis.window || null : null);
  if (keyHost && keyHost.addEventListener) {
    keyHost.addEventListener('keydown', onKey, true);
    keyHost.addEventListener('keyup', onKeyUp, true);
  }

  // ---------- 開局 / 結束 ----------
  function start(id) {
    if (disposed || playing) return false;
    const b = byId(id);
    if (!b) return false;
    const busy = isBusy();
    const r = checkPlay(b, { stars: getStars(), busy, money: getMoney() });
    if (!r.ok) {
      say(r.text, 3);
      return false;
    }
    if (!spend(b.price, 'minigame')) {
      say(`錢不夠：${b.name} NT$${b.price}`, 3);
      return false;
    }
    booth = b;
    playing = b.id;
    if (b.id === 'balloon') {
      alive.fill(true);
      bal.shots = 0;
      bal.popped = 0;
      bal.done = false;
      bal.outward = 0;
      if (view) view.resetBalloons();
      equipPistol();
      say(`射氣球：${BALLOON_SHOTS} 發內打破 ${BALLOON_WIN} 顆得 NT$${BALLOON_REWARD}、全破 NT$${BALLOON_ALL_REWARD}（瞄兩顆中間可一槍兩顆）`, 4);
    } else {
      pa.balls = 0;
      pa.scores.length = 0;
      pa.charging = false;
      pa.power = 0;
      pa.finished = false;
      pa.acc = 0;
      pa.reward = 0;
      pa.lastSlot = -1;
      games++;
      pa.seed = (typeof pachinkoSeed === 'function' ? Number(pachinkoSeed()) : Number.isFinite(pachinkoSeed) ? pachinkoSeed : Date.now() ^ Math.imul(games, 0x9e3779b9)) >>> 0;
      pa.rng = createRng(pa.seed);
      ball.active = false;
      if (ui) {
        setText('msgText', ui.msg, '按住空白鍵 / Enter / 「發射」蓄力，放開發射');
        ui.fire.textContent = '發射（按住蓄力）';
        ui.leave.textContent = '離開（Esc，不退費）';
        ui.panel.hidden = false;
      }
    }
    emit('minigame:start', { id: b.id, price: b.price });
    refreshUi();
    return true;
  }

  // 結算 / 結束：reason 'done' 才發獎金、記最佳；其他 = 結束不退費（reward 0）
  function finish(reason) {
    const id = playing;
    if (!id) return null;
    const score = id === 'balloon' ? bal.popped : pa.scores.reduce((a, b) => a + b, 0);
    let reward = 0;
    let newBest = false;
    if (reason === 'done') {
      reward = id === 'balloon' ? balloonReward(score) : pachinkoReward(pa.scores);
      if (score > best[id]) {
        best[id] = score;
        newBest = true;
      }
      if (reward > 0) earn(reward, 'minigame');
      emit('ui:sound', { kind: reward > 0 ? 'reward' : 'fail' });
    }
    const name = id === 'balloon' ? '射氣球' : '彈珠台';
    const unit = id === 'balloon' ? '顆' : '分';
    const text = reason === 'done'
      ? `${name}：${score} ${unit}${reward > 0 ? `，得 NT$${reward}` : '，沒得獎'}${newBest ? '（新紀錄！）' : ''}`
      : `${name}結束（${reason === 'wanted' ? '被通緝' : reason === 'left' ? '離開攤位' : reason === 'foul' ? '換武器或朝攤位外開槍' : '中途放棄'}，不退費）`;
    if (id === 'balloon') {
      playing = null;
      booth = null;
      if (view) view.resetBalloons();
      alive.fill(true);
      say(text, 4);
    } else if (reason === 'done') {
      pa.finished = true; // 面板留著顯示結果，Enter / Esc / 點擊關閉
      pa.reward = reward;
      if (ui) {
        setText('msgText', ui.msg, `${text}｜Enter / Esc 關閉`);
        ui.fire.textContent = '關閉';
        ui.leave.textContent = '關閉（Esc）';
      }
    } else {
      closePanel();
      say(text, 4);
    }
    const payload = { id, score, reward, reason, best: best[id], newBest };
    emit('minigame:end', payload);
    refreshUi();
    return payload;
  }

  function closePanel() {
    playing = null;
    booth = null;
    pa.charging = false;
    ball.active = false;
    if (ui) ui.panel.hidden = true;
  }

  // 彈珠台結果畫面關閉（已結算）
  function close() {
    if (playing !== 'pachinko') return;
    if (!pa.finished) {
      quit('esc');
      return;
    }
    closePanel();
    refreshUi();
  }

  // 玩中放棄（Esc / 走遠 / 通緝）：不退費
  function quit(reason = 'esc') {
    if (!playing) return null;
    if (playing === 'pachinko' && pa.finished) {
      close();
      return null;
    }
    return finish(reason);
  }

  // ---------- 射氣球命中（weapon:fire）----------
  // 射線是否朝氣球牆：槍口離站位 ≤ 12 m、與攤位正面夾角 ≤ 30°、在牆前方且穿過牆面寬度內（不配置）
  function aimedAtWall(ox, oz, dx, dy, dz) {
    if (!balloonBooth || !(Number.isFinite(ox) && Number.isFinite(oz) && Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz))) return false;
    const rx = ox - balloonBooth.x;
    const rz = oz - balloonBooth.z;
    if (rx * rx + rz * rz > BALLOON_AIM_DIST * BALLOON_AIM_DIST) return false;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0)) return false;
    const dlz = (dx * fwdS + dz * fwdC) / len; // 方向的本地 +Z 分量 = 與正面夾角餘弦
    if (dlz < AIM_COS) return false;
    const lz0 = rx * fwdS + rz * fwdC;
    if (lz0 >= BALLOON_WALL_Z) return false;
    const lx0 = rx * fwdC - rz * fwdS;
    const dlx = (dx * fwdC - dz * fwdS) / len;
    return Math.abs(lx0 + (dlx * (BALLOON_WALL_Z - lz0)) / dlz) <= BALLOON_WALL_HALF;
  }
  // 局中豁免判定（整合層 weapon:fire 犯行監聽在本模組 onFire 之前執行，只看 payload）
  function exemptShot(e) {
    return playing === 'balloon' && !!e && e.weapon === BALLOON_WEAPON && aimedAtWall(e.x, e.z, e.dirX, e.dirY, e.dirZ);
  }
  function shieldShots(origin, dir) {
    if (playing !== 'balloon' || !origin || !dir) return false;
    if (typeof getWeapon === 'function' && getWeapon() !== BALLOON_WEAPON) return false;
    return aimedAtWall(origin.x, origin.z, dir.x, dir.y, dir.z);
  }

  function onFire(e) {
    if (playing !== 'balloon' || bal.done || !e || !e.byPlayer) return; // 已打完：下一次 update / game:pause 結算
    if (e.weapon !== BALLOON_WEAPON) {
      finish('foul'); // 局中用其他武器開火（整合層已照常報 gunfire）
      return;
    }
    if (!aimedAtWall(e.x, e.z, e.dirX, e.dirY, e.dirZ)) {
      if (++bal.outward >= BALLOON_FOUL_SHOTS) finish('foul'); // 朝攤位外：不算發數、照常報 gunfire；連 3 發 → 結束
      return;
    }
    bal.outward = 0;
    bal.shots++;
    let maxT = Infinity;
    if (!e.miss && Number.isFinite(e.ex)) {
      const len = Math.hypot(e.dirX, e.dirY, e.dirZ) || 1;
      maxT = ((e.ex - e.x) * e.dirX + (e.ey - e.y) * e.dirY + (e.ez - e.z) * e.dirZ) / len;
    }
    const n = rayBalloonHits(e.x, e.y, e.z, e.dirX, e.dirY, e.dirZ, maxT, centers, alive, hits);
    for (let k = 0; k < n; k++) {
      alive[hits[k]] = false;
      if (view) view.setBalloon(hits[k], false);
    }
    bal.popped += n;
    if (n > 0) emit('ui:sound', { kind: 'click' }); // 氣球破（audio UI_KINDS）
    if (bal.popped >= BALLOON_COUNT || bal.shots >= BALLOON_SHOTS) bal.done = true; // 下一次 update 結算（本發仍豁免犯行）
    refreshUi();
  }

  // ---------- 彈珠台操作 ----------
  function pressLaunch() {
    if (playing !== 'pachinko' || pa.finished || ball.active || pa.balls >= PACHINKO_BALLS || pa.charging) return false;
    pa.charging = true;
    pa.power = 0;
    return true;
  }
  function releaseLaunch() {
    if (playing !== 'pachinko' || !pa.charging) return false;
    pa.charging = false;
    launchBall(ball, Math.max(POWER_MIN, pa.power));
    pa.balls++;
    pa.power = 0;
    refreshUi();
    return true;
  }

  // 面板每幀（整合層在 syncPanels 之前呼叫，世界暫停中照跑）：蓄力 + 固定子步模擬；回傳是否開著
  function updatePanel(dt) {
    if (playing !== 'pachinko') return false;
    const h = dt > 0 ? Math.min(dt, 0.1) : 0;
    if (pa.charging) pa.power = chargePower(pa.power, h);
    if (ball.active) {
      pa.acc += h;
      while (pa.acc >= SIM_STEP && ball.active) {
        pa.acc -= SIM_STEP;
        const slot = pachinkoStep(ball, SIM_STEP, pa.rng);
        if (slot >= 0) {
          pa.scores.push(SLOT_SCORES[slot]);
          pa.lastSlot = slot;
          if (ui) setText('msgText', ui.msg, `落入 ${SLOT_SCORES[slot]} 分格`);
        }
      }
      if (!ball.active) pa.acc = 0;
    }
    if (!ball.active && !pa.finished && pa.balls >= PACHINKO_BALLS && pa.scores.length >= PACHINKO_BALLS) finish('done');
    refreshUi();
    return true;
  }

  // ---------- 每幀（世界）----------
  // ctx = { x, z, onFoot, frozen }（main 重用同一物件）
  function update(dt, ctx) {
    if (disposed) return;
    if (view) view.update(dt);
    if (playing !== 'balloon' || !ctx) return;
    if (bal.done) {
      finish('done');
      return;
    }
    if ((Number(getStars()) || 0) >= 1) {
      finish('wanted');
      return;
    }
    const d = Math.hypot(ctx.x - booth.x, ctx.z - booth.z);
    if (!ctx.onFoot || ctx.frozen || d > LEAVE_DIST) {
      finish('left');
      return;
    }
    refreshUi();
  }

  function nearest(pos) {
    if (disposed || playing || !pos) return null;
    let bestB = null;
    let bestD = MINIGAME_RADIUS;
    for (const b of booths) {
      const d = Math.hypot(pos.x - b.x, pos.z - b.z);
      if (d <= bestD) {
        bestD = d;
        bestB = b;
      }
    }
    if (!bestB) return null;
    inter.id = `minigame:${bestB.id}`;
    inter.dist = bestD;
    inter.booth = bestB;
    inter.text = promptText(bestB);
    return inter;
  }

  // 回主選單 / 開新局：無聲收場（不發事件、不退費）
  function cancel() {
    if (playing === 'pachinko') closePanel();
    playing = null;
    booth = null;
    bal.done = false;
    bal.outward = 0;
    alive.fill(true);
    if (view) view.resetBalloons();
    refreshUi();
  }

  function serialize() {
    return minigameRecord({ balloon: { best: best.balloon }, pachinko: { best: best.pachinko } });
  }
  function restore(rec) {
    const r = minigameRecord(rec);
    best.balloon = r ? r.balloon.best : 0;
    best.pachinko = r ? r.pachinko.best : 0;
  }
  function stats() {
    statsOut.minigameBalloonBest = best.balloon;
    statsOut.minigamePachinkoBest = best.pachinko;
    return statsOut;
  }

  const offs = [];
  if (bus) {
    offs.push(bus.on('weapon:fire', onFire));
    // 射氣球局中暫停：最後一發已打完（結算等下一幀）→ 先正常結算；按 Esc（暫停選單）= 結束不退費；切視窗自動暫停（autoPause）→ 局保留
    offs.push(bus.on('game:pause', (e) => {
      if (!e || !e.paused || playing !== 'balloon') return;
      if (bal.done) finish('done');
      else if (!autoPause) finish('esc');
    }));
    // 局中換成非攤位武器 → 結束 foul（開局 equipPistol 換到手槍本身不算）
    offs.push(bus.on('weapon:equip', (e) => {
      if (playing === 'balloon' && e && e.weapon !== BALLOON_WEAPON) finish(bal.done ? 'done' : 'foul');
    }));
  }

  function dispose() {
    cancel();
    disposed = true;
    for (const off of offs.splice(0)) if (typeof off === 'function') off();
    if (keyHost && keyHost.removeEventListener) {
      keyHost.removeEventListener('keydown', onKey, true);
      keyHost.removeEventListener('keyup', onKeyUp, true);
    }
    if (ui) for (const n of [ui.bar, ui.panel]) if (n.parentNode) n.parentNode.removeChild(n);
    if (view) view.dispose();
  }

  return {
    booths,
    centers,
    nearest,
    start,
    update,
    updatePanel,
    pressLaunch,
    releaseLaunch,
    quit,
    close,
    cancel,
    markers: () => markerList,
    serialize,
    restore,
    stats,
    best: (id) => best[id] || 0,
    // 局中（含 10 發打完、下一幀結算前）且手槍朝氣球牆：exemptShot(e) 玩家開槍不算 gunfire、shieldShots(origin, dir) 子彈不傷行人
    exemptShot,
    shieldShots,
    // 整合層：滑鼠鎖定失效自動開暫停選單前 true、之後 false（該次 game:pause 不視為放棄）
    setAutoPause: (on) => {
      autoPause = !!on;
    },
    panelOpen: () => playing === 'pachinko',
    get active() {
      return playing !== null;
    },
    get playing() {
      return playing;
    },
    get booth() {
      return booth;
    },
    get balloon() {
      return { shots: bal.shots, left: BALLOON_SHOTS - bal.shots, popped: bal.popped, done: bal.done, outward: bal.outward, alive };
    },
    get pachinko() {
      return { balls: pa.balls, scores: pa.scores, charging: pa.charging, power: pa.power, finished: pa.finished, reward: pa.reward, ball, seed: pa.seed };
    },
    el: ui ? ui.panel : null,
    dispose,
  };
}
