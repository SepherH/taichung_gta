// P19 機車飛車搶包（Scooter Snatch）：騎機車以 ≥ SNATCH_SPEED_MIN 的車速經過行人身邊按 E → 搶包
// 純邏輯（不 import three / DOM）：行人掃描、包包機率、金額、連擊倍率、摔車掉錢全部可在 node 無頭測試
// 用法（整合層 main.js）：
//   const snatch = createSnatch({ bus, adapters });
//   每幀（駕駛分支）snatch.update(dt, ctx)；ctx 見下；snatch.target 非 null 時出提示 SNATCH_PROMPT，按 E → snatch.act()
//   開新局 / 回主選單 → snatch.cancel()；讀檔 → snatch.restore(save.stats)（統計本身走 economy，缺欄位視 0）
//   機車倒地當幀即下車（main.js handleFall → exitVehicle），update 看不到翻覆 → 整合層在下車前呼叫 snatch.crash()
// ctx（每幀重用同一個物件即可，本檔不保留參考）：
//   riding   玩家是否正在駕駛（非步行 / 上車中 / 搶車中）
//   type     目前車種（只有 SNATCH_VEHICLE 'scooter' 能搶，汽車不行）
//   speed    沿車頭方向的車速（m/s，負值為倒車；門檻取絕對值）
//   overturned 車輛翻覆 / 機車倒地（Vehicle.isOverturned()）
//   x, z     玩家（車身）位置
//   peds     骨架行人陣列（traffic.peds：{ actor: { id, pos }, citizen, brain }）；既有查詢為 O(n) 全量，
//            故本檔每 SCAN_INTERVAL 秒才掃一次（每幀只驗證已選定目標，不配置物件）
//   frozen   暫停 / 重生 / 面板開啟等：不掃描、不判摔車（計時照樣停住）
// adapters（皆選用，省略時該後果退化而不報錯）：
//   flee(ped)                    行人尖叫逃跑（main.js 接 ped.brain.onThreatened({ pos: 玩家位置 })）
//   reportCrime(crime, { x, z, witnessed })  通緝（main.js 接 wanted.report）
//   provokeGang(ped)             搶到幫派成員 → 該幫敵意（main.js 接 gangs.provokeActor）
//   idOf(ped)                    行人穩定 id（省略時取 citizen.id ?? actor.id）
// 金錢不在本檔入帳：economy.js 訂閱 snatch:success / snatch:drop 自行加扣並累計統計（同 ped:knockdown 慣例）

export const SNATCH_VEHICLE = 'scooter'; // 只有機車能飛車搶包
export const SNATCH_SPEED_MIN = 6; // m/s：低於此車速不算飛車搶包
export const SNATCH_RADIUS = 1.8; // m：行人與車身的水平距離門檻
export const SNATCH_BAG_CHANCE = 0.6; // 行人身上有包包的機率（以行人 id 雜湊決定，同一人每次結果相同）
export const SNATCH_MIN = 50; // NT$：單次搶得金額下限（未乘連擊倍率）
export const SNATCH_MAX = 300; // NT$：上限
export const COMBO_WINDOW = 30; // s：連擊有效期間（逾時重置）
export const COMBO_MULTS = Object.freeze([1, 1.5, 2, 3]); // 第 n 次連續成功的倍率（index = combo − 1，上限 3）
export const CRASH_SPEED_DROP = 8; // m/s：單幀車速瞬降超過此值視為摔車
export const SCAN_INTERVAL = 0.2; // s：行人掃描間隔（既有近距查詢為 O(n) 全量）
export const SNATCH_PROMPT = '按 E 搶包';
export const CRIME_SNATCH = 'snatch'; // wanted.js CRIMES：1 星
export const CRIME_SNATCH_COMBO = 'snatchCombo'; // 連擊 ≥ COMBO_WANTED_AT：2 星
export const COMBO_WANTED_AT = 3;

// 32 bit FNV-1a：行人 id（數字或字串）+ 用途標籤 → 無號整數，同輸入永遠同輸出（不耗 rng、存檔無關）
export function hashId(id, salt = '') {
  const s = `${salt}:${id}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 該行人身上有沒有包包（純邏輯、穩定）
export function hasBag(id, chance = SNATCH_BAG_CHANCE) {
  return hashId(id, 'bag') % 1000 < Math.round(chance * 1000);
}

// 該行人包內金額（NT$，SNATCH_MIN–SNATCH_MAX 含兩端，穩定）
export function bagAmount(id, min = SNATCH_MIN, max = SNATCH_MAX) {
  return min + (hashId(id, 'amount') % (max - min + 1));
}

// 第 combo 次連續成功的倍率（combo 由 1 起算；超過表長取最後一項 = 上限 3）
export function comboMult(combo, mults = COMBO_MULTS) {
  if (!(combo >= 1)) return mults[0];
  return mults[Math.min(Math.floor(combo), mults.length) - 1];
}

const defaultIdOf = (p) => {
  if (!p) return null;
  if (p.citizen && p.citizen.id != null) return p.citizen.id;
  return p.actor ? p.actor.id : null;
};

export function createSnatch({ bus, adapters = {}, config = {} } = {}) {
  const cfg = {
    speedMin: config.speedMin ?? SNATCH_SPEED_MIN,
    radius: config.radius ?? SNATCH_RADIUS,
    bagChance: config.bagChance ?? SNATCH_BAG_CHANCE,
    min: config.min ?? SNATCH_MIN,
    max: config.max ?? SNATCH_MAX,
    window: config.window ?? COMBO_WINDOW,
    mults: config.mults || COMBO_MULTS,
    crashDrop: config.crashDrop ?? CRASH_SPEED_DROP,
    scanInterval: config.scanInterval ?? SCAN_INTERVAL,
    vehicle: config.vehicle ?? SNATCH_VEHICLE,
  };
  const idOf = adapters.idOf || defaultIdOf;
  const emit = (name, payload) => {
    if (bus && bus.emit) bus.emit(name, payload);
  };

  const snatched = new Set(); // 已被搶過的行人 id（骨架回池後 citizen.snatched 另外標記一份）
  // 被寫過 citizen.snatched 的市民：Traffic 全程只建一次、行人不隨新局重建，cancel 時須一併清旗標
  const flagged = new Set();
  let combo = 0;
  let comboT = 0; // 距上次成功的秒數
  let lastAmount = 0; // 最近一次搶得金額（摔車掉一半；掉過或連擊重置即歸零，不重複掉）
  let total = 0; // 本局總搶包次數（統計以 economy 為準，這裡供 HUD / 除錯）
  let totalMoney = 0;
  let target = null; // 目前鎖定的行人（{ ped, id }）
  let scanT = cfg.scanInterval; // 起始即滿：第一次符合條件的那一幀立刻掃
  let lastSpeed = 0;
  let wasOverturned = false;
  let ctxX = 0;
  let ctxZ = 0;

  const isSnatched = (ped, id) => snatched.has(id) || !!(ped && ped.citizen && ped.citizen.snatched);

  // 車種 / 車速門檻（每幀便宜檢查）
  const eligible = (ctx) => !!ctx && !ctx.frozen && !!ctx.riding && ctx.type === cfg.vehicle
    && Math.abs(Number(ctx.speed) || 0) >= cfg.speedMin && !ctx.overturned;

  const within = (ped) => {
    const pos = ped && ped.actor && ped.actor.pos;
    if (!pos) return false;
    const dx = pos.x - ctxX;
    const dz = pos.z - ctxZ;
    return dx * dx + dz * dz <= cfg.radius * cfg.radius;
  };

  // O(n) 全量掃描：每 SCAN_INTERVAL 秒一次，取範圍內最近、還沒被搶過的行人
  function scan(peds) {
    target = null;
    if (!peds) return;
    let bestD2 = cfg.radius * cfg.radius;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const pos = p && p.actor && p.actor.pos;
      if (!pos) continue;
      const id = idOf(p);
      if (id == null || isSnatched(p, id)) continue;
      const dx = pos.x - ctxX;
      const dz = pos.z - ctxZ;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        target = p;
      }
    }
  }

  // 連擊歸零（逾時 / 摔車 / cancel）：最近一筆贓款同時失效，之後摔車不再掉錢
  function resetCombo() {
    combo = 0;
    comboT = 0;
    lastAmount = 0;
  }

  // 摔車：翻覆（false → true）或單幀車速瞬降超過門檻 → 掉最近一次搶得金額的一半、連擊重置
  function crash() {
    const drop = Math.floor(lastAmount / 2);
    resetCombo();
    if (drop > 0) emit('snatch:drop', { amount: drop });
  }

  return {
    // 每幀；ctx 見檔頭。不配置物件、不每幀全量掃行人
    update(dt, ctx) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (!ctx) {
        target = null;
        return;
      }
      ctxX = Number(ctx.x) || 0;
      ctxZ = Number(ctx.z) || 0;
      const speed = Math.abs(Number(ctx.speed) || 0);
      const riding = !!ctx.riding && ctx.type === cfg.vehicle;

      if (combo > 0) {
        comboT += step;
        if (comboT >= cfg.window) resetCombo();
      }

      if (ctx.frozen) {
        target = null;
        lastSpeed = speed;
        wasOverturned = !!ctx.overturned;
        return;
      }

      // 摔車判定：只在騎機車時成立（下車 / 換車不算）
      if (riding) {
        const flipped = !!ctx.overturned && !wasOverturned;
        const slammed = lastSpeed - speed > cfg.crashDrop;
        if (flipped || slammed) crash();
      }
      lastSpeed = speed;
      wasOverturned = !!ctx.overturned;

      if (!eligible(ctx)) {
        target = null;
        scanT = cfg.scanInterval; // 下次符合條件時立刻掃一次
        return;
      }
      scanT += step;
      // 已鎖定的目標每幀只驗證自己（便宜）：離開範圍 / 已被搶 → 退回等下次掃描
      // 掃描只依 scanInterval（沒有目標也等間隔，不每幀全量掃）
      if (target && (!within(target) || isSnatched(target, idOf(target)))) target = null;
      if (scanT >= cfg.scanInterval) {
        scanT = 0;
        scan(ctx.peds);
      }
    },

    // 按下互動鍵：對目前鎖定的行人搶包。回傳 'success' | 'fail' | null（沒有目標 / 條件不符）
    act() {
      const ped = target;
      if (!ped) return null;
      const id = idOf(ped);
      if (id == null || isSnatched(ped, id) || !within(ped)) {
        target = null;
        return null;
      }
      target = null;
      scanT = cfg.scanInterval; // 目標已用掉：下一幀立刻找下一位（一次性，不是每幀）
      // 永久標記：同一行人只能被搶一次（成功或沒包都算搶過）
      snatched.add(id);
      if (ped.citizen) {
        ped.citizen.snatched = true;
        flagged.add(ped.citizen);
      }
      // 不論有沒有包，行人都尖叫逃跑（被搶的當下）
      if (adapters.flee) adapters.flee(ped);

      if (!hasBag(id, cfg.bagChance)) {
        emit('snatch:fail', { pedId: id });
        return 'fail';
      }

      combo++;
      comboT = 0;
      const mult = comboMult(combo, cfg.mults);
      const amount = Math.round(bagAmount(id, cfg.min, cfg.max) * mult);
      lastAmount = amount;
      total++;
      totalMoney += amount;
      emit('snatch:success', { pedId: id, amount, combo, mult });

      if (adapters.reportCrime) {
        adapters.reportCrime(combo >= COMBO_WANTED_AT ? CRIME_SNATCH_COMBO : CRIME_SNATCH, { x: ctxX, z: ctxZ, witnessed: false });
      }
      if (adapters.provokeGang && ped.citizen && ped.citizen.gang) adapters.provokeGang(ped);
      return 'success';
    },

    // 外部通知摔車（main.js handleFall：機車倒地當幀即下車，update 的翻覆判定看不到）→ 掉最近一筆一半並重置連擊
    crash,

    // 目前鎖定的行人（null = 沒得搶）；main.js 以此決定互動提示
    get target() {
      return target;
    },
    get prompt() {
      return target ? SNATCH_PROMPT : null;
    },
    get combo() {
      return combo;
    },
    get mult() {
      return combo > 0 ? comboMult(combo, cfg.mults) : 1;
    },
    get comboLeft() {
      return combo > 0 ? Math.max(0, cfg.window - comboT) : 0;
    },
    get total() {
      return total;
    },
    get totalMoney() {
      return totalMoney;
    },
    // 讀檔：統計本身存在 economy（save.stats），這裡只同步顯示用的累計值；缺欄位視 0
    restore(stats) {
      const s = stats || {};
      total = Number.isFinite(s.snatches) && s.snatches > 0 ? Math.floor(s.snatches) : 0;
      totalMoney = Number.isFinite(s.snatchMoney) && s.snatchMoney > 0 ? Math.floor(s.snatchMoney) : 0;
    },
    // 開新局 / 回主選單：連擊、鎖定目標、已被搶名單（含 citizen.snatched 旗標）全部歸零
    cancel() {
      resetCombo();
      target = null;
      lastAmount = 0;
      scanT = cfg.scanInterval;
      lastSpeed = 0;
      wasOverturned = false;
      snatched.clear();
      for (const c of flagged) c.snatched = false;
      flagged.clear();
      total = 0;
      totalMoney = 0;
    },
  };
}
