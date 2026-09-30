// 經濟與統計：金錢（整數、不為負）與各項統計計數；訂閱 bus 事件自動累計，金錢變動一律 emit 'player:money'
// bus 由呼叫端注入（on(name, fn) → off、emit(name, payload)）；rng 可注入以便測試掉錢金額
import { validateSave, defaultSave } from './save.js';

export const START_MONEY = 500;
export const HOSPITAL_FEE = 100;
export const LOOT_MIN = 10;
export const LOOT_MAX = 40;

const toAmount = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

export function createEconomy({ bus, initial, rng = Math.random } = {}) {
  // 初值沿用存檔清洗規則（非法 / 缺鍵 → 預設）
  const init = (initial && validateSave({ money: initial.money, stats: initial.stats })) || defaultSave();
  let money = init.money;
  const stats = { ...init.stats };

  function emitMoney(delta, reason) {
    if (bus) bus.emit('player:money', { money, delta, reason });
  }

  // 收入：回實際入帳金額
  function add(n, reason = 'income') {
    const amt = toAmount(n);
    if (!amt) return 0;
    money += amt;
    stats.moneyEarned += amt;
    emitMoney(amt, reason);
    return amt;
  }

  // 支出：餘額不足則不扣、回 false
  function spend(n, reason = 'spend') {
    const amt = toAmount(n);
    if (!amt) return true;
    if (money < amt) return false;
    money -= amt;
    stats.moneySpent += amt;
    emitMoney(-amt, reason);
    return true;
  }

  // 強制扣款（醫藥費）：扣到 0 為止，回實際扣款
  function charge(n, reason) {
    const amt = Math.min(toAmount(n), money);
    if (!amt) return 0;
    money -= amt;
    stats.moneySpent += amt;
    emitMoney(-amt, reason);
    return amt;
  }

  function rollLoot() {
    let r = Number(rng());
    if (!Number.isFinite(r)) r = 0;
    r = Math.min(Math.max(r, 0), 0.999999);
    return LOOT_MIN + Math.floor(r * (LOOT_MAX - LOOT_MIN + 1));
  }

  const offs = [];
  if (bus) {
    offs.push(bus.on('ped:knockdown', (e) => {
      if (!e || !e.byPlayer) return;
      if (e.cause === 'vehicle') stats.pedsHit++;
      else if (e.cause === 'punch') {
        stats.pedsKnockedOut++;
        add(rollLoot(), 'loot');
      }
    }));
    offs.push(bus.on('vehicle:carjacked', () => { stats.carjacks++; }));
    offs.push(bus.on('vehicle:crash', () => { stats.crashes++; }));
    offs.push(bus.on('player:ko', () => {
      stats.kos++;
      charge(HOSPITAL_FEE, 'hospital');
    }));
  }

  return {
    get money() { return money; },
    get stats() { return { ...stats }; },
    add,
    spend,
    addDistance(kind, m) {
      if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) return;
      if (kind === 'walk') stats.distWalkM += m;
      else if (kind === 'drive') stats.distDriveM += m;
    },
    addPlayTime(dt) {
      if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return;
      stats.playTimeSec += dt;
    },
    snapshot() {
      return { money, stats: { ...stats } };
    },
    dispose() {
      for (const off of offs.splice(0)) {
        try { if (typeof off === 'function') off(); } catch (e) { /* 忽略 */ }
      }
    },
  };
}
