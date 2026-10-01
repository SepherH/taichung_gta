// 玩家設定（契約 §2 / §11 / §21）：畫質、鏡頭靈敏度、反轉 Y、音量、FPS 顯示、提示、UI 縮放、血液顯示、後座力、瞄準輔助、天氣
// 以 JSON 存在 storage 的 SETTINGS_KEY；storage 由呼叫端注入（node 測試用假物件），預設為安全包裝的 localStorage
// 讀寫全部 try/catch：無痕模式 / 停用儲存 / node 無 window 時只存在記憶體，不丟例外
// 舊版遷移：SETTINGS_KEY 不存在時讀舊的三段靈敏度（input.js 早期版本存的 'low'/'mid'/'high'）當初值；
//   遷移結果寫入 SETTINGS_KEY 成功後刪除舊鍵（v1 已存在但舊鍵殘留時也順手刪除），避免舊碼 / 除錯時讀到過期值

export const SETTINGS_KEY = 'tcgta.settings.v1';
export const LEGACY_SENS_KEYS = { mouse: 'tcgta.lookSens.mouse', touch: 'tcgta.lookSens.touch' };
const LEGACY_SENS_MUL = { low: 0.6, mid: 1.0, high: 1.6 };

// type：enum（values）/ number（min、max、step 可省略）/ boolean
export const SETTINGS_SCHEMA = {
  quality: { type: 'enum', values: ['auto', 'low', 'mid', 'high', 'ultra'], default: 'auto', label: '畫質' },
  lookSensMouse: { type: 'number', min: 0.3, max: 3.0, step: 0.1, default: 1.0, label: '滑鼠視角靈敏度' },
  lookSensTouch: { type: 'number', min: 0.3, max: 3.0, step: 0.1, default: 1.0, label: '觸控視角靈敏度' },
  invertY: { type: 'boolean', default: false, label: '反轉 Y 軸' },
  volumeMaster: { type: 'number', min: 0, max: 1, default: 0.8, label: '主音量' },
  volumeMusic: { type: 'number', min: 0, max: 1, default: 0.6, label: '音樂音量' },
  volumeSfx: { type: 'number', min: 0, max: 1, default: 0.9, label: '音效音量' },
  showFps: { type: 'boolean', default: false, label: '顯示 FPS' },
  showHints: { type: 'boolean', default: true, label: '顯示操作提示' },
  uiScale: { type: 'number', min: 0.8, max: 1.3, step: 0.05, default: 1.0, label: '介面縮放' },
  // Phase 4（§11）
  showBlood: { type: 'boolean', default: true, label: '顯示血液' },
  recoil: { type: 'number', min: 0.2, max: 1.0, step: 0.1, default: 1.0, label: '後座力' },
  aimAssist: { type: 'boolean', default: true, label: '瞄準輔助' }, // 只作用於觸控
  // Phase 5（§21.1）：'auto' = 晴 / 雨 / 霧隨時間變化；其他 = 固定該天氣
  weather: { type: 'enum', values: ['auto', 'clear', 'rain', 'fog'], default: 'auto', label: '天氣' },
};

function defaults() {
  const o = {};
  for (const k of Object.keys(SETTINGS_SCHEMA)) o[k] = SETTINGS_SCHEMA[k].default;
  return o;
}

// 合法 → 正規化後的值；非法 → undefined
export function normalizeSetting(key, value) {
  const s = SETTINGS_SCHEMA[key];
  if (!s) return undefined;
  if (s.type === 'enum') return s.values.includes(value) ? value : undefined;
  if (s.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  let v = Math.min(s.max, Math.max(s.min, value));
  if (s.step) v = s.min + Math.round((v - s.min) / s.step) * s.step;
  v = Math.min(s.max, Math.max(s.min, v));
  return Number(v.toFixed(6)); // 去掉浮點誤差（0.30000000000000004 → 0.3）
}

// 安全包裝 localStorage：取不到或存取丟例外一律當作不存在
function defaultStorage() {
  const ls = () => {
    try {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    } catch (err) {
      return null;
    }
  };
  return {
    getItem(k) {
      const s = ls();
      return s ? s.getItem(k) : null;
    },
    setItem(k, v) {
      const s = ls();
      if (s) s.setItem(k, v);
    },
    removeItem(k) {
      const s = ls();
      if (s && s.removeItem) s.removeItem(k);
    },
  };
}

function safeGet(storage, k) {
  try {
    return storage.getItem(k);
  } catch (err) {
    return null;
  }
}

function safeSet(storage, k, v) {
  try {
    storage.setItem(k, v);
    return true;
  } catch (err) {
    return false; // 只存記憶體
  }
}

function safeRemove(storage, k) {
  try {
    if (storage.removeItem) storage.removeItem(k);
  } catch (err) {
    // 停用儲存：忽略
  }
}

function removeLegacy(storage) {
  for (const key of Object.values(LEGACY_SENS_KEYS)) {
    if (safeGet(storage, key) !== null) safeRemove(storage, key);
  }
}

function loadInitial(storage) {
  const out = defaults();
  const raw = safeGet(storage, SETTINGS_KEY);
  if (raw === null || raw === undefined) {
    // 舊版遷移：三段靈敏度 → 連續倍率
    let migrated = false;
    for (const [kind, key] of [['mouse', 'lookSensMouse'], ['touch', 'lookSensTouch']]) {
      const id = safeGet(storage, LEGACY_SENS_KEYS[kind]);
      if (Object.prototype.hasOwnProperty.call(LEGACY_SENS_MUL, id)) {
        out[key] = LEGACY_SENS_MUL[id];
        migrated = true;
      }
    }
    return { values: out, migrated };
  }
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    obj = null; // 損毀 → 用預設
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { values: out, migrated: false };
  for (const k of Object.keys(SETTINGS_SCHEMA)) {
    const v = normalizeSetting(k, obj[k]);
    if (v !== undefined) out[k] = v;
  }
  return { values: out, migrated: false };
}

export function createSettings({ storage } = {}) {
  const st = storage || defaultStorage();
  const { values, migrated } = loadInitial(st);
  const subs = new Set();

  const persist = () => safeSet(st, SETTINGS_KEY, JSON.stringify(values));
  // 遷移結果只做一次；寫入成功才刪舊鍵（寫入失敗 = 下次載入仍可從舊鍵遷移）
  if (migrated) {
    if (persist()) removeLegacy(st);
  } else if (safeGet(st, SETTINGS_KEY) !== null) {
    removeLegacy(st); // 舊版已遷移但沒刪舊鍵的殘留
  }

  const notify = (key) => {
    const all = { ...values };
    for (const fn of [...subs]) {
      try {
        fn(key, values[key], all);
      } catch (err) {
        console.error('[settings] 訂閱者發生例外：', err);
      }
    }
  };

  const apply = (key, v) => {
    if (values[key] === v) return;
    values[key] = v;
    persist();
    notify(key);
  };

  return {
    get(key) {
      return values[key];
    },
    // 非法值（未知鍵 / 型別不符 / 不在選項內 / 非有限數）回 false 且不存；數值 clamp 到範圍並取 step
    set(key, value) {
      const v = normalizeSetting(key, value);
      if (v === undefined) return false;
      apply(key, v);
      return true;
    },
    getAll() {
      return { ...values };
    },
    // 省略 key = 全部回預設
    reset(key) {
      const keys = key === undefined ? Object.keys(SETTINGS_SCHEMA) : [key];
      for (const k of keys) if (SETTINGS_SCHEMA[k]) apply(k, SETTINGS_SCHEMA[k].default);
    },
    // fn(key, value, all)；回傳取消函式
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

// 全域單例（整合用）
export const settings = createSettings();
