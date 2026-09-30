// 畫質分級（契約 §3）：各級的解析度上限、陰影、人車數與 LOD 半徑；純邏輯，node 可測
// 決定順序：URL ?q=low|mid|high|ultra 優先 → 設定值（非 auto）→ auto：觸控裝置 low、桌機 high
// 人數（主控裁決，Phase 3 用戶要求路人多）：peds low 40 / mid 80 / high 140 / ultra 200；cars 同契約 §3
// pedNear：此半徑內行人完整骨架動畫與碰撞；pedFar：此外改替身；中間降頻 / 簡化（crowd.js 依此分層）

export const QUALITY_IDS = ['low', 'mid', 'high', 'ultra'];

export const QUALITY_TIERS = {
  low: { id: 'low', label: '低', dprCap: 1, shadowMap: 0, peds: 40, cars: 18, pedNear: 30, pedFar: 70, viewDist: 420 },
  mid: { id: 'mid', label: '中', dprCap: 1.25, shadowMap: 1024, peds: 80, cars: 30, pedNear: 40, pedFar: 90, viewDist: 650 },
  high: { id: 'high', label: '高', dprCap: 1.5, shadowMap: 2048, peds: 140, cars: 45, pedNear: 50, pedFar: 110, viewDist: 900 },
  ultra: { id: 'ultra', label: '極致', dprCap: 2, shadowMap: 4096, peds: 200, cars: 60, pedNear: 60, pedFar: 130, viewDist: 1300 },
};

const MOTORBIKE_SHARE = 0.4; // 車流中機車比例

// setting：settings.get('quality')（'auto' | tier id）；touch：是否觸控裝置；urlQ：網址的 q 參數（可為 null）
export function resolveQuality(setting, { touch = false, urlQ = null } = {}) {
  if (QUALITY_IDS.includes(urlQ)) return urlQ;
  if (QUALITY_IDS.includes(setting)) return setting;
  return touch ? 'low' : 'high';
}

// 該級參數副本（未知 id 當 high）；另含 motorbikeShare
export function qualityBudget(id) {
  const t = QUALITY_TIERS[id] || QUALITY_TIERS.high;
  return { ...t, motorbikeShare: MOTORBIKE_SHARE };
}
