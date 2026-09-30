// 事件匯流排（契約 §1）：同步 emit、單一 listener 例外隔離、emit 期間增刪 listener 安全
// 模組內部一律用呼叫端注入的 bus；全域單例 bus 只給整合層（main.js）使用
// 事件名稱與 payload 定稿表見 docs/dev/interfaces.md §1

export function createBus() {
  const map = new Map(); // name → entry 陣列（每次增刪都換新陣列，emit 走訪的是當下快照）

  // 移除符合 pred 的 entry，並標記 dead（讓進行中的 emit 跳過）
  function remove(name, pred) {
    const list = map.get(name);
    if (!list) return;
    const next = [];
    for (const l of list) {
      if (pred(l)) l.dead = true;
      else next.push(l);
    }
    if (next.length) map.set(name, next);
    else map.delete(name);
  }

  function add(name, fn, once) {
    if (typeof fn !== 'function') throw new TypeError('bus listener 必須是函式');
    const entry = { fn, once, dead: false };
    map.set(name, [...(map.get(name) || []), entry]);
    return () => remove(name, (l) => l === entry);
  }

  return {
    // 回傳取消訂閱函式
    on(name, fn) {
      return add(name, fn, false);
    },
    // 只觸發一次；觸發前也可用回傳的函式取消
    once(name, fn) {
      return add(name, fn, true);
    },
    // 移除該事件上所有同一函式的訂閱
    off(name, fn) {
      remove(name, (l) => l.fn === fn);
    },
    emit(name, payload) {
      const list = map.get(name);
      if (!list) return;
      for (const l of list) {
        if (l.dead) continue; // emit 期間被 off 的 listener 不再呼叫
        if (l.once) remove(name, (x) => x === l);
        try {
          l.fn(payload);
        } catch (err) {
          console.error(`[bus] 事件 ${name} 的 listener 發生例外：`, err);
        }
      }
    },
  };
}

// 全域單例（整合用）
export const bus = createBus();
