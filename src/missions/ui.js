// 任務 UI（契約 §16，前綴 ms-）：上中目標列 + 字幕（z-index 55）、接單卡 / 結算 / 失敗面板（z-index 85）
// 只負責 DOM：文案全部由呼叫端傳入（manifest 或內建委託），本檔不寫任何委託內容
// 面板按鈕 ≥ 44 px、safe-area、直向可讀（樣式見 missions.css）；鍵盤：E / Enter = 主按鈕、Esc = 次按鈕
// 目標列文字只在內容改變時寫入 DOM（每幀呼叫也不重寫）
import { CARGO_BASE } from './catalog.js';

export const CONDITION_LABELS = { fragile: '易碎', heavy: '超重', timed: '限時' };
const SUBTITLE_SEC = 5;

export function formatClock(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function formatNT(n) {
  const v = Math.round(Number(n) || 0);
  return `NT$${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

// slug → 穩定的卡片底色（圖卡缺檔時的純色卡片）
export function cargoColor(slug) {
  let h = 0;
  const s = String(slug || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 42%)`;
}

export function createMissionUi({ root, doc = globalThis.document, keyTarget = null, cargoBase = CARGO_BASE, onAction = () => {} } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return createNullUi();
  const host = root || doc.body;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---------- 目標列 + 字幕 ----------
  const hud = el('div', 'ms-hud');
  const obj = el('div', 'ms-objective');
  const objText = el('span', 'ms-obj-text');
  const objTimer = el('span', 'ms-obj-chip ms-obj-timer');
  const objDist = el('span', 'ms-obj-chip ms-obj-dist');
  const objDmg = el('span', 'ms-obj-chip ms-obj-damage');
  obj.append(objText, objTimer, objDist, objDmg);
  const sub = el('div', 'ms-subtitle');
  hud.append(obj, sub);
  obj.hidden = true;
  sub.hidden = true;

  // ---------- 面板 ----------
  const panel = el('div', 'ms-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const card = el('div', 'ms-card');
  panel.appendChild(card);

  host.appendChild(hud);
  host.appendChild(panel);

  let mode = null; // 'offer' | 'result' | 'fail' | null
  let primary = null;
  let secondary = null;
  let subLeft = 0;
  const last = { text: null, timer: null, dist: null, dmg: null, urgent: null };

  function clearCard() {
    while (card.firstChild) card.removeChild(card.firstChild);
  }

  function button(label, action, cls) {
    const b = el('button', `ms-btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      onAction(action);
    });
    return b;
  }

  // 圖卡：art/cargo/<file>；缺檔 / 載入失敗 → 純色卡片 + 貨物名稱
  function artBlock(m) {
    const art = el('div', 'ms-card-art');
    art.style.background = cargoColor(m.slug);
    const fallback = el('div', 'ms-card-art-name', m.name || m.title);
    art.appendChild(fallback);
    if (m.file) {
      const img = el('img', 'ms-card-img');
      img.alt = m.name || m.title;
      img.addEventListener('load', () => {
        fallback.hidden = true;
      });
      img.addEventListener('error', () => {
        img.hidden = true;
        fallback.hidden = false;
      });
      img.src = cargoBase + m.file;
      art.appendChild(img);
    }
    return art;
  }

  function tags(m) {
    const box = el('div', 'ms-tags');
    for (const c of m.conditions) box.appendChild(el('span', `ms-tag ms-tag-${c}`, CONDITION_LABELS[c] || c));
    if (!m.conditions.length) box.appendChild(el('span', 'ms-tag', '一般'));
    return box;
  }

  function statRow(label, value, cls = '') {
    const row = el('div', `ms-stat ${cls}`);
    row.append(el('span', 'ms-stat-k', label), el('span', 'ms-stat-v', value));
    return row;
  }

  function open(nextMode, body, primaryBtn, secondaryBtn) {
    const actions = el('div', 'ms-actions');
    actions.append(primaryBtn, secondaryBtn);
    body.appendChild(actions);
    primary = primaryBtn;
    secondary = secondaryBtn;
    mode = nextMode;
    panel.dataset.mode = nextMode;
    panel.hidden = false;
    if (primaryBtn.focus) primaryBtn.focus();
  }

  // 接單卡：m = 正規化委託；info = { timeLimitSec, fromName, toName }
  function showOffer(m, info) {
    clearCard();
    card.appendChild(artBlock(m));
    const body = el('div', 'ms-card-body');
    body.appendChild(el('div', 'ms-kicker', '日常打工 · 送貨委託'));
    body.appendChild(el('h2', 'ms-card-title', m.title));
    if (m.client) body.appendChild(el('div', 'ms-card-client', `委託人：${m.client}`));
    if (m.brief) body.appendChild(el('p', 'ms-card-brief', m.brief));
    body.appendChild(tags(m));
    const stats = el('div', 'ms-stats');
    stats.appendChild(statRow('路線', `${info.fromName} → ${info.toName}`));
    stats.appendChild(statRow('報酬', formatNT(m.reward), 'ms-stat-money'));
    stats.appendChild(statRow('限時', info.timeLimitSec > 0 ? formatClock(info.timeLimitSec) : '不限'));
    body.appendChild(stats);
    card.appendChild(body);
    open('offer', body, button('接下', 'accept', 'ms-btn-primary'), button('算了', 'decline', 'ms-btn-ghost'));
  }

  // 結算：r = { title, name, slug, file, conditions, timeSec, damagePct, base, bonus, reward, best }
  function showResult(r) {
    clearCard();
    card.appendChild(artBlock(r));
    const body = el('div', 'ms-card-body');
    body.appendChild(el('div', 'ms-kicker ms-kicker-ok', '送達！'));
    body.appendChild(el('h2', 'ms-card-title', r.title));
    const stats = el('div', 'ms-stats');
    stats.appendChild(statRow('用時', formatClock(r.timeSec)));
    if (r.conditions.includes('fragile')) stats.appendChild(statRow('損壞度', `${Math.round(r.damagePct)}%`));
    stats.appendChild(statRow('基本報酬', formatNT(r.base)));
    if (r.bonus > 0) stats.appendChild(statRow('提早加成', `+${formatNT(r.bonus)}`));
    stats.appendChild(statRow('實得', formatNT(r.reward), 'ms-stat-money'));
    if (r.best) stats.appendChild(statRow('最佳紀錄', formatClock(r.best)));
    body.appendChild(stats);
    card.appendChild(body);
    open('result', body, button('再接一單', 'again', 'ms-btn-primary'), button('繼續', 'continue', 'ms-btn-ghost'));
  }

  // 失敗：f = { title, slug, name, file, conditions, reasonText }
  function showFail(f) {
    clearCard();
    card.appendChild(artBlock(f));
    const body = el('div', 'ms-card-body');
    body.appendChild(el('div', 'ms-kicker ms-kicker-fail', '委託失敗'));
    body.appendChild(el('h2', 'ms-card-title', f.title));
    body.appendChild(el('p', 'ms-card-brief', f.reasonText));
    card.appendChild(body);
    open('fail', body, button('重試', 'retry', 'ms-btn-primary'), button('繼續', 'close', 'ms-btn-ghost'));
  }

  function closePanel() {
    panel.hidden = true;
    mode = null;
    primary = null;
    secondary = null;
    clearCard();
  }

  function onKey(e) {
    if (!mode || !e || e.repeat) return;
    const code = e.code || e.key;
    let target = null;
    if (code === 'KeyE' || code === 'e' || code === 'Enter' || code === 'NumpadEnter') target = primary;
    else if (code === 'Escape' || code === 'Esc') target = secondary;
    if (!target) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    target.click();
  }
  const keyHost = keyTarget || doc;
  if (keyHost && keyHost.addEventListener) keyHost.addEventListener('keydown', onKey, true);

  // 目標列：傳 null 隱藏；各欄空字串 = 不顯示該膠囊
  function setObjective(text, timer = '', dist = '', dmg = '', urgent = false) {
    if (text === null) {
      if (!obj.hidden) obj.hidden = true;
      last.text = null;
      return;
    }
    if (obj.hidden) obj.hidden = false;
    if (last.text !== text) objText.textContent = last.text = text;
    if (last.timer !== timer) {
      objTimer.textContent = last.timer = timer;
      objTimer.hidden = !timer;
    }
    if (last.dist !== dist) {
      objDist.textContent = last.dist = dist;
      objDist.hidden = !dist;
    }
    if (last.dmg !== dmg) {
      objDmg.textContent = last.dmg = dmg;
      objDmg.hidden = !dmg;
    }
    if (last.urgent !== urgent) {
      last.urgent = urgent;
      if (urgent) objTimer.classList.add('ms-urgent');
      else objTimer.classList.remove('ms-urgent');
    }
  }

  function subtitle(text, sec = SUBTITLE_SEC) {
    sub.textContent = text;
    sub.hidden = !text;
    subLeft = text ? sec : 0;
  }

  function update(dt) {
    if (subLeft > 0) {
      subLeft -= dt;
      if (subLeft <= 0) {
        subLeft = 0;
        sub.hidden = true;
      }
    }
  }

  function dispose() {
    if (keyHost && keyHost.removeEventListener) keyHost.removeEventListener('keydown', onKey, true);
    if (hud.parentNode) hud.parentNode.removeChild(hud);
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    mode = null;
  }

  return {
    showOffer,
    showResult,
    showFail,
    closePanel,
    isOpen: () => mode !== null,
    mode: () => mode,
    setObjective,
    subtitle,
    update,
    dispose,
    els: { hud, obj, objText, objTimer, objDist, objDmg, sub, panel, card },
  };
}

// 無 DOM（node 無 document）：全部 no-op，面板視為未開
function createNullUi() {
  const noop = () => {};
  return {
    showOffer: noop,
    showResult: noop,
    showFail: noop,
    closePanel: noop,
    isOpen: () => false,
    mode: () => null,
    setObjective: noop,
    subtitle: noop,
    update: noop,
    dispose: noop,
    els: null,
  };
}
