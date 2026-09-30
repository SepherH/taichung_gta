// 委託目錄（契約 §16）：讀美術線的 art/cargo/manifest.json → 正規化委託清單；缺檔 / 壞檔 → 內建 3 個委託
// 純資料模組、不碰 DOM / three：fetchJson 由呼叫端注入（node 測試用假物件）
// manifest 接受 { items: [...] } 或頂層陣列；欄位別名容錯：title/name、brief/text/desc、timeLimitSec/timeLimit、from/start、to/end
// 美術實檔欄位：{ slug, name, file, title, brief, from, to, distance, timeLimit, reward, tags: [...] }；conditions 讀 raw.conditions ?? raw.tags
//   只有 fragile / heavy / timed 進 conditions；原始 tag（含未知，如 smelly）全部保留在 tags 供 UI 顯示趣味標籤
//   timeLimitSec：timed 者為倒數時限（超時失敗）；其餘只作提早完成加成的基準（UI 顯示「建議時間」）
// from / to 以地標 id（數字或字串皆以字串比對）或 slug 對應；對不到（或起訖相同）的委託丟棄，只 console.info 一次

export const CARGO_MANIFEST_URL = 'art/cargo/manifest.json';
export const CARGO_BASE = 'art/cargo/';
export const CONDITIONS = ['fragile', 'heavy', 'timed'];
export const DEFAULT_REWARD = 300;
export const MAX_REWARD = 100000;

// 內建委託：manifest 缺檔時使用（文案幽默但不影射真實人物 / 品牌；起訖為 manifest 12 棟地標的 slug）
export const BUILTIN_MISSIONS = [
  {
    slug: 'singing-sun-cakes',
    name: '會唱歌的太陽餅（一整箱）',
    file: '',
    title: '一整箱會唱歌的太陽餅',
    client: '歌劇院後台的和聲指導',
    brief: '這箱太陽餅每一塊都會飆高音，撞一下就集體走音。今晚彩排缺和聲，拜託開穩一點，別讓它們唱成走調的流行歌。',
    from: 'shin_kong_mitsukoshi',
    to: 'national_taichung_theater',
    timeLimitSec: 0,
    reward: 450,
    conditions: ['fragile'],
  },
  {
    slug: 'backup-backup-mic',
    name: '備用麥克風的備用麥克風',
    file: '',
    title: '急送：備用麥克風的備用麥克風',
    client: '很緊張的議事廳音控人員',
    brief: '主麥克風壞了，備用麥克風說它壓力太大也想要一支備用。會議兩分鐘後開始，這支備用的備用麥克風一定要準時到！',
    from: 'taichung_city_hall',
    to: 'taichung_city_council',
    timeLimitSec: 120,
    reward: 380,
    conditions: ['timed'],
  },
  {
    slug: 'swimming-lake-water',
    name: '會自己游泳的湖水（一桶）',
    file: '',
    title: '一桶會自己游泳的湖水',
    client: '秋紅谷的退休水質觀察員',
    brief: '這桶湖水每天早上都會自己游三圈，最近吵著要去飯店泡一次正式的澡。它很重，而且會在桶子裡亂晃，走路請慢慢來。',
    from: 'qiuhonggu_pavilion',
    to: 'lin_hotel',
    timeLimitSec: 0,
    reward: 520,
    conditions: ['heavy'],
  },
];

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const firstStr = (...vals) => {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return '';
};
const SAFE_FILE_RE = /^[\w.\-一-鿿]+\.(png|jpe?g|webp|gif|avif|svg)$/i;

// 圖檔名只收同目錄的單純檔名（不含路徑 / ..）；不合法 → ''（UI 顯示純色卡片）
export function safeCargoFile(file) {
  const s = str(file);
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..') || !SAFE_FILE_RE.test(s)) return '';
  return s;
}

// 條件 / 標籤：陣列或以逗號 / 空白 / | 分隔的字串 → 小寫去重；known = true 時只留 CONDITIONS
function normTags(v, known) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s|]+/) : [];
  const out = [];
  for (const c of list) {
    const k = str(c).toLowerCase();
    if (!k || (known && !CONDITIONS.includes(k)) || out.includes(k)) continue;
    out.push(k);
  }
  return out;
}

// 地標查找表：id（字串化）與 slug 皆可對應
export function landmarkIndex(landmarks) {
  const map = new Map();
  if (!Array.isArray(landmarks)) return map;
  for (const l of landmarks) {
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.z)) continue;
    if (l.slug && !map.has(String(l.slug))) map.set(String(l.slug), l);
    if (l.id !== undefined && l.id !== null && !map.has(String(l.id))) map.set(String(l.id), l);
  }
  return map;
}

// 單筆原始資料 → 正規化委託；缺必要欄位回 null；地標對不到回 { unresolved: true }
function normalizeItem(raw, index, lmIndex) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fileRaw = str(raw.file);
  const slug = firstStr(raw.slug, raw.id, fileRaw.replace(/\.[a-z0-9]+$/i, '')) || `cargo-${index + 1}`;
  const title = firstStr(raw.title, raw.name);
  if (!title) return null;
  const fromKey = firstStr(raw.from, raw.start);
  const toKey = firstStr(raw.to, raw.end);
  const from = fromKey ? lmIndex.get(fromKey) : null;
  const to = toKey ? lmIndex.get(toKey) : null;
  if (!from || !to || from === to) return { unresolved: true, slug };
  const tl = Number(raw.timeLimitSec !== undefined ? raw.timeLimitSec : raw.timeLimit);
  const rw = Number(raw.reward);
  const dist = Number(raw.distance);
  const condRaw = raw.conditions ?? raw.tags;
  return {
    slug,
    name: firstStr(raw.name, raw.title),
    file: safeCargoFile(fileRaw),
    title,
    client: firstStr(raw.client),
    brief: firstStr(raw.brief, raw.text, raw.desc),
    from,
    to,
    timeLimitSec: Number.isFinite(tl) && tl > 0 ? Math.round(tl) : 0,
    reward: Number.isFinite(rw) && rw > 0 ? Math.min(MAX_REWARD, Math.round(rw)) : DEFAULT_REWARD,
    conditions: normTags(condRaw, true),
    tags: normTags(raw.tags ?? raw.conditions, false),
    distance: Number.isFinite(dist) && dist > 0 ? Math.round(dist) : 0,
  };
}

// 原始清單 → { list, dropped: [slug] }；slug 重複保留第一筆
export function normalizeCatalog(rawList, landmarks) {
  const lmIndex = landmarkIndex(landmarks);
  const list = [];
  const dropped = [];
  const seen = new Set();
  if (!Array.isArray(rawList)) return { list, dropped };
  rawList.forEach((raw, i) => {
    const m = normalizeItem(raw, i, lmIndex);
    if (!m) return;
    if (m.unresolved) {
      dropped.push(m.slug);
      return;
    }
    if (seen.has(m.slug)) return;
    seen.add(m.slug);
    list.push(m);
  });
  return { list, dropped };
}

// manifest 內容 → 原始清單；不是物件 / 陣列（例如回退成 index.html 字串）→ null
export function manifestItems(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.items)) return data.items;
  return null;
}

// 載入：回 { list, source: 'manifest'|'builtin', dropped }；永不丟例外
export async function loadCatalog({ fetchJson, landmarks, url = CARGO_MANIFEST_URL, info = console.info } = {}) {
  let items = null;
  if (typeof fetchJson === 'function') {
    try {
      items = manifestItems(await fetchJson(url));
    } catch {
      items = null;
    }
  }
  if (items) {
    const res = normalizeCatalog(items, landmarks);
    const note = res.dropped.length ? `${res.dropped.length} 筆委託的起訖地標對不到，已略過：${res.dropped.join(', ')}` : '';
    if (res.list.length) {
      if (note) info(`[missions] ${note}`);
      return { list: res.list, source: 'manifest', dropped: res.dropped };
    }
    info(`[missions] 貨物 manifest 沒有可用的委託${note ? `（${note}）` : ''}，改用內建委託`);
  } else {
    info('[missions] 找不到貨物 manifest（或格式不符），改用內建委託');
  }
  const res = normalizeCatalog(BUILTIN_MISSIONS, landmarks);
  return { list: res.list, source: 'builtin', dropped: res.dropped };
}
