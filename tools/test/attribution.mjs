// 授權標示（#attribution）與 HUD 版面無頭檢查：解析 src/style.css 與 index.html
// ① ODbL 標示貼角落、小字半透明、不吃指標事件且只有一處；② index.html 已移除舊 #help 與寫死鍵位的提示文字；
// ③ 以 CSS 規則數值（calc / min / var / env、@media 方向、transform scale 與 transform-origin）推算桌機 / 觸控橫向 / 觸控直向
//    多種尺寸（640×360 起到 1920×1080）下各元素矩形：授權標示、HUD 元素、觸控鈕 / 踏板兩兩不重疊且都在畫面內；
// ④ 觸控控制彼此不重疊：搖桿底座靜止位置 × 步行按鈕（直向攻擊鈕）、駕駛踏板 × 手煞 / 下車 / 喇叭鈕。
// 用法：node tools/test/attribution.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const css = readFileSync(`${ROOT}src/style.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(`${ROOT}index.html`, 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, info = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? `  (${info})` : ''}`);
}

// ---------- CSS 解析：規則（含 @media 條件）依原始順序 ----------
function parseDecl(body) {
  const decl = {};
  for (const d of body.split(';')) {
    const i = d.indexOf(':');
    if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return decl;
}

function parseBlocks(src, media, out) {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const prelude = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) parseBlocks(body, prelude.slice(6).trim(), out);
    else if (!prelude.startsWith('@')) out.push({ sels: prelude.split(',').map((s) => s.trim()), decl: parseDecl(body), media });
    i = j;
  }
  return out;
}
const RULES = parseBlocks(css, null, []);

function mediaOk(media, vp) {
  if (!media) return true;
  if (!vp) return false;
  return media.split(/\band\b/).every((part) => {
    const m = /\(\s*([\w-]+)\s*:\s*([^)]+)\)/.exec(part);
    if (!m) return true;
    const [, feat, val] = m;
    if (feat === 'orientation') return (vp.h > vp.w ? 'portrait' : 'landscape') === val.trim();
    if (feat === 'max-width') return vp.w <= parseFloat(val);
    if (feat === 'min-width') return vp.w >= parseFloat(val);
    if (feat === 'max-height') return vp.h <= parseFloat(val);
    if (feat === 'min-height') return vp.h >= parseFloat(val);
    return false;
  });
}

// 依選擇器鏈（由低到高特異度）合併宣告；vp 省略 = 只看不在 @media 內的規則
function resolve(chain, vp = null) {
  const decl = {};
  for (const sel of chain) {
    for (const r of RULES) if (r.sels.includes(sel) && mediaOk(r.media, vp)) Object.assign(decl, r.decl);
  }
  return decl;
}
// 選擇器完全等於 selector 的基礎規則（不含 @media）
const rule = (selector) => resolve([selector]);

// ---------- 長度求值：calc / min / max / var / env；% 依軸向取視窗寬或高 ----------
function evalLen(v, axis, vp, vars) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s || s === 'auto' || s === 'none' || /content/.test(s)) return null;
  s = s.replace(/env\([^)]*\)/g, '0px');
  for (let k = 0; k < 4 && /var\(/.test(s); k++) {
    s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fb) => (name in vars ? String(vars[name]) : fb || '0'));
  }
  s = s.replace(/(-?\d*\.?\d+)(px|vw|vh|%)/g, (_, n, u) => {
    const x = parseFloat(n);
    if (u === 'px') return String(x);
    if (u === 'vw') return String((x * vp.w) / 100);
    if (u === 'vh') return String((x * vp.h) / 100);
    return String((x * (axis === 'x' ? vp.w : vp.h)) / 100);
  });
  s = s.replace(/calc\(/g, '(').replace(/(^|[^.\w])(min|max)\(/g, '$1Math.$2(');
  if (!/^[\d\s+\-*/().,]*$/.test(s.replace(/Math\.(min|max)/g, ''))) throw new Error(`無法求值：${v} → ${s}`);
  return Function(`return (${s});`)();
}

// 元素矩形（未套 transform）；回傳 { x, y, w, h, decl }
function box(decl, vp, vars) {
  const L = (k, axis) => evalLen(decl[k], axis, vp, vars);
  const left = L('left', 'x');
  const right = L('right', 'x');
  const top = L('top', 'y');
  const bottom = L('bottom', 'y');
  let w = L('width', 'x');
  if (w === null && left !== null && right !== null) w = vp.w - left - right;
  const maxW = L('max-width', 'x');
  if (w === null) w = maxW;
  else if (maxW !== null) w = Math.min(w, maxW);
  let h = L('height', 'y');
  if (h === null && top !== null && bottom !== null) h = vp.h - top - bottom;
  const maxH = L('max-height', 'y');
  if (h === null) h = maxH;
  else if (maxH !== null) h = Math.min(h, maxH);
  if (w === null || h === null) throw new Error(`寬高無法由規則推算：${JSON.stringify(decl)}`);
  let x = left !== null ? left : vp.w - right - w;
  const y = top !== null ? top : vp.h - bottom - h;
  if (/translateX\(\s*-50%\s*\)/.test(decl.transform || '') && left !== null) x -= w / 2;
  return { x, y, w, h, decl };
}

// transform: scale(k) 以 transform-origin 所指的角縮放
function applyScale(b, vp, vars) {
  const m = /scale\(([^)]*\)?)\)/.exec(b.decl.transform || '');
  if (!m) return b;
  const k = evalLen(m[1], 'x', vp, vars);
  const o = b.decl['transform-origin'] || 'center';
  const w = b.w * k;
  const h = b.h * k;
  const x = /right/.test(o) ? b.x + b.w - w : /left/.test(o) ? b.x : b.x + (b.w - w) / 2;
  const y = /bottom/.test(o) ? b.y + b.h - h : /top/.test(o) ? b.y : b.y + (b.h - h) / 2;
  return { ...b, x, y, w, h };
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const fmt = (r) => `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}×${r.h.toFixed(0)}`;

// ---------- 授權標示 ----------
const base = rule('#attribution');
const touch = rule('body.touch #attribution');
const px = (v) => parseFloat(v);

check('#attribution 規則存在', Object.keys(base).length > 0);
check('position: fixed', base.position === 'fixed', base.position);
check('z-index 高於 HUD（10）與觸控層（9）', Number(base['z-index']) > 10, base['z-index']);
check('pointer-events: none', base['pointer-events'] === 'none', base['pointer-events']);
check('white-space: nowrap', base['white-space'] === 'nowrap', base['white-space']);
check('bottom 以 calc + env(safe-area-inset-bottom) 定位', /calc\(.*env\(safe-area-inset-bottom\)/.test(base.bottom || ''), base.bottom);
check(
  'left 或 right 以 calc + env(safe-area-inset-*) 定位',
  /calc\(.*env\(safe-area-inset-(left|right)\)/.test(base.left || base.right || ''),
  base.right || base.left,
);
check('不用 top 定位（貼底角）', !('top' in base) && !('top' in touch));
check('字級 10–11 px', px(base['font-size']) >= 10 && px(base['font-size']) <= 11, base['font-size']);
check('opacity ≈ 0.55', Math.abs(px(base.opacity) - 0.55) <= 0.05, base.opacity);
check('窄螢幕 ellipsis（overflow hidden + text-overflow）', base.overflow === 'hidden' && base['text-overflow'] === 'ellipsis');
check('無背景或極淡背景', !base.background && !base['background-color']);
check('沒有任何規則把 #attribution 隱藏', !RULES.some((r) => r.sels.some((s) => /#attribution\b/.test(s) && !/#attribution\s+\S/.test(s)) && (r.decl.display === 'none' || r.decl.visibility === 'hidden' || r.decl.opacity === '0')));

check('觸控版規則存在', Object.keys(touch).length > 0);
check('觸控版 bottom 以 env(safe-area-inset-bottom) 定位', /env\(safe-area-inset-bottom\)/.test(touch.bottom || ''), touch.bottom);
check('觸控版 left 以 env(safe-area-inset-left) 定位', /env\(safe-area-inset-left\)/.test(touch.left || ''), touch.left);
check('觸控版字級 10–11 px', px(touch['font-size']) >= 10 && px(touch['font-size']) <= 11, touch['font-size']);

// 載入畫面上連結可點
check('載入畫面另設 pointer-events: auto', rule('#loading:not(.hidden) ~ #attribution')['pointer-events'] === 'auto');

// index.html：只有一個 #attribution，連結文字完整
const ids = html.match(/id="attribution"/g) || [];
check('index.html 只有一個 #attribution', ids.length === 1, `${ids.length} 個`);
check('連結文字「OpenStreetMap contributors」保留', />OpenStreetMap contributors<\/a>/.test(html));
check('「ODbL」保留', /id="attribution"[^\n]*ODbL/.test(html));
check('#loading 位於 #attribution 之前（~ 選擇器生效）', html.indexOf('id="loading"') < html.indexOf('id="attribution"'));
check('#attribution 不在 #hud 內（HUD 隱藏時仍常駐）', html.indexOf('id="attribution"') > html.indexOf('<!-- 手機'));

// ---------- index.html：舊說明面板與寫死鍵位 ----------
check('舊 #help 面板已移除', !/id="help"/.test(html));
check('#ctrl-hint 為空容器（文字由 hud.setControlsHint 產生）', /<div id="ctrl-hint"><\/div>/.test(html));
check('#touch-hint 為空容器', /<div id="touch-hint"><\/div>/.test(html));
const hudHtml = html.slice(html.indexOf('<div id="hud"'), html.indexOf('<!-- 手機'));
check('HUD 內沒有寫死的按鍵（<b>鍵</b>、H 說明、O 靈敏度、E 揮拳、R 翻車）', !/<b>|H 說明|O 靈敏度|E<\/b>|揮拳|翻車/.test(hudHtml));
{
  const need = ['fps', 'hint-card', 'hint-close', 'status', 'clock', 'money', 'money-delta', 'minimap', 'health', 'health-fill', 'drive-panel', 'road-sign', 'road-name', 'vehicle-label', 'speedo-arc', 'speed-num', 'prompt', 'prompt-text', 'toast'];
  const missing = need.filter((id) => !new RegExp(`id="${id}"`).test(hudHtml));
  check(`HUD 新元素齊全（${need.length} 個 id）`, !missing.length, missing.join(', '));
}

// ---------- 版面推算 ----------
// 授權標示文字寬度估算：全形字 = 字級、半形 = 0.6 × 字級
const attrText = (/id="attribution">([\s\S]*?)<\/div>/.exec(html) || [, ''])[1].replace(/<[^>]+>/g, '');
function textWidth(text, fs) {
  let w = 0;
  for (const ch of text) w += /[⺀-￯]/.test(ch) ? fs : fs * 0.6;
  return w;
}

function attrRect(isTouch, vp) {
  const d = resolve(isTouch ? ['#attribution', 'body.touch #attribution'] : ['#attribution'], vp);
  const fs = px(d['font-size']);
  const lh = px(d['line-height']);
  const vars = {};
  const w = Math.min(textWidth(attrText, fs), evalLen(d['max-width'], 'x', vp, vars));
  const h = fs * lh;
  const bottom = evalLen(d.bottom, 'y', vp, vars);
  const left = d.left && d.left !== 'auto' ? evalLen(d.left, 'x', vp, vars) : null;
  const x = left !== null ? left : vp.w - evalLen(d.right, 'x', vp, vars) - w;
  return { name: '#attribution', x, y: vp.h - bottom - h, w, h };
}

// HUD 元素（依模式）與其選擇器鏈
function hudRects(isTouch, driving, vp, scale) {
  const vars = { '--hud-scale': scale };
  const chain = (id) => (isTouch ? [`#${id}`, `body.touch #${id}`] : [`#${id}`]);
  const ids = ['fps', 'status', 'minimap-wrap', 'prompt', 'toast', isTouch ? 'touch-hint' : 'ctrl-hint'];
  if (driving) ids.push('drive-panel');
  // 觸控駕駛中新手提示卡延後顯示（hud.js _hintBlocked），桌機駕駛中照常
  if (!(isTouch && driving)) ids.push('hint-card');
  const out = [];
  for (const id of ids) {
    let b = box(resolve(chain(id), vp), vp, vars);
    if (id === 'status') {
      // 金錢 +/− 在狀態列下方：併入狀態列矩形後一起縮放
      const d = resolve(chain('money-delta'), vp);
      const dy = evalLen(d.top, 'y', vp, vars) + evalLen(d.height, 'y', vp, vars);
      const dw = evalLen(d.right, 'x', vp, vars) + evalLen(d.width, 'x', vp, vars);
      const w = Math.max(b.w, dw);
      b = { ...b, x: b.x + b.w - w, w, h: Math.max(b.h, dy) };
    }
    out.push({ name: `#${id}`, ...applyScale(b, vp, vars) });
  }
  return out;
}

// 觸控鈕（touch.js 預設按鈕 + 預留的 tl3）與駕駛踏板區
const WALK_SLOTS = ['main', 'sec1', 'sec2', 'attack', 'tl1', 'tl2', 'tl3'];
const DRIVE_SLOTS = ['sec2', 'sec3', 'top1', 'tl1', 'tl2', 'tl3'];
function controlRects(driving, vp) {
  const out = [];
  const modeSel = driving ? 'body.touch-drive' : 'body.touch-walk';
  for (const slot of driving ? DRIVE_SLOTS : WALK_SLOTS) {
    out.push({ name: `.slot-${slot}`, ...box(resolve(['.tbtn', `.tbtn.slot-${slot}`, `${modeSel} .tbtn.slot-${slot}`], vp), vp, {}) });
  }
  if (driving) {
    const d = resolve(['#touch-pedals', 'body.touch-drive #touch-pedals'], vp);
    const c = box(d, vp, {});
    const parts = [];
    let buf = '';
    let depth = 0;
    for (const ch of d.padding) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ' ' && depth === 0) {
        if (buf) parts.push(buf);
        buf = '';
      } else buf += ch;
    }
    if (buf) parts.push(buf);
    const [pt, pr, pb, pl] = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]].map((v, i) => evalLen(v, i % 2 ? 'x' : 'y', vp, {}));
    out.push({ name: '#touch-pedals', x: c.x + pl, y: c.y + pt, w: c.w - pl - pr, h: c.h - pt - pb });
  }
  return out;
}

// 搖桿底座靜止位置（left / top 為圓心，margin 往左上回推半徑）
function stickRect(vp) {
  const d = resolve(['#tstick-base'], vp);
  const [mt, , , ml] = d.margin.split(/\s+/).map((v) => evalLen(v, 'x', vp, {}));
  const w = evalLen(d.width, 'x', vp, {});
  const h = evalLen(d.height, 'y', vp, {});
  return { name: '#tstick-base', x: evalLen(d.left, 'x', vp, {}) + ml, y: evalLen(d.top, 'y', vp, {}) + mt, w, h };
}

// 兩矩形間距（重疊時為負：取兩軸穿透量較小者的相反數）
function gap(a, b) {
  const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return overlap(a, b) ? Math.max(gx, gy) : Math.max(gx, gy, 0);
}

function layoutCheck(label, isTouch, driving, vp, scale) {
  const hud = hudRects(isTouch, driving, vp, scale);
  const ctrl = isTouch ? controlRects(driving, vp) : [];
  if (isTouch && !driving) ctrl.push(stickRect(vp));
  const attr = attrRect(isTouch, vp);
  const bad = [];
  const all = [...hud, attr];
  for (const r of all) {
    if (r.x < -0.01 || r.y < -0.01 || r.x + r.w > vp.w + 0.01 || r.y + r.h > vp.h + 0.01 || r.w <= 0 || r.h <= 0) bad.push(`${r.name} 超出畫面 ${fmt(r)}`);
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) if (overlap(all[i], all[j])) bad.push(`${all[i].name}[${fmt(all[i])}] × ${all[j].name}[${fmt(all[j])}]`);
    for (const c of ctrl) if (c.name !== '#tstick-base' && overlap(all[i], c)) bad.push(`${all[i].name}[${fmt(all[i])}] × ${c.name}[${fmt(c)}]`);
  }
  // 觸控控制兩兩不重疊（按鈕、踏板、搖桿底座）；按鈕 / 踏板須在畫面內
  for (let i = 0; i < ctrl.length; i++) {
    const c = ctrl[i];
    if (c.name !== '#tstick-base' && (c.x < -0.01 || c.y < -0.01 || c.x + c.w > vp.w + 0.01 || c.y + c.h > vp.h + 0.01)) bad.push(`${c.name} 超出畫面 ${fmt(c)}`);
    for (let j = i + 1; j < ctrl.length; j++) if (overlap(c, ctrl[j])) bad.push(`${c.name}[${fmt(c)}] × ${ctrl[j].name}[${fmt(ctrl[j])}]`);
  }
  // 授權標示貼角：底緣距畫面底 ≤ 6px，左或右緣距畫面邊 ≤ 12px
  const corner = vp.h - (attr.y + attr.h) <= 6 && (attr.x <= 12 || vp.w - (attr.x + attr.w) <= 12);
  if (!corner) bad.push(`#attribution 不在角落 ${fmt(attr)}`);
  check(`${label} ${vp.w}×${vp.h} ${driving ? '駕駛' : '步行'} 縮放 ${scale}：授權標示 / HUD / 觸控鈕互不重疊`, !bad.length, bad.slice(0, 3).join('；'));
  return { hud, ctrl, attr };
}

const DESKTOP = [[800, 600], [1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080]];
const TOUCH_LAND = [[640, 360], [667, 375], [740, 360], [800, 360], [809, 375], [844, 390], [932, 430], [1024, 768], [1280, 800]];
const TOUCH_PORT = [[360, 640], [360, 740], [375, 667], [390, 844], [393, 852], [412, 915], [414, 896], [430, 932], [768, 1024]];

// 介面縮放：hud.js 在觸控或視窗短邊 < 700 px 時把 --hud-scale 限制在 ≤ 1（SMALL_SCREEN），其餘到 settings 上限 1.3
const scalesFor = (w, h) => (Math.min(w, h) < 700 ? [0.8, 1] : [0.8, 1, 1.3]);
for (const [w, h] of DESKTOP) {
  for (const scale of scalesFor(w, h)) for (const driving of [false, true]) layoutCheck('桌機', false, driving, { w, h }, scale);
}
for (const [w, h] of TOUCH_LAND) {
  for (const scale of [0.8, 1]) for (const driving of [false, true]) layoutCheck('觸控橫向', true, driving, { w, h }, scale);
}
for (const [w, h] of TOUCH_PORT) {
  for (const scale of [0.8, 1]) for (const driving of [false, true]) layoutCheck('觸控直向', true, driving, { w, h }, scale);
}

// 實測修正：直向步行搖桿底座 × 攻擊鈕（390×844 曾重疊 16×27 px）；360×640 到 430×932 每 10 px 掃描
{
  let worst = Infinity;
  let at = '';
  for (let w = 360; w <= 430; w += 10) {
    for (let h = 640; h <= 932; h += 12) {
      const vp = { w, h };
      const atk = controlRects(false, vp).find((r) => r.name === '.slot-attack');
      const g = gap(stickRect(vp), atk);
      if (g < worst) {
        worst = g;
        at = `${w}×${h}`;
      }
    }
  }
  check('直向 360×640–430×932：搖桿底座與攻擊鈕不重疊（間距 ≥ 4 px）', worst >= 4, `最小間距 ${worst.toFixed(1)} px @ ${at}`);
}

// 實測修正：駕駛時手煞 / 下車鈕不疊在踏板上（橫向曾重疊 65–72 px、直向 43–72 px）；手煞在油門那一側
{
  let worst = Infinity;
  let at = '';
  let sideOk = true;
  for (const [w, h] of [...TOUCH_LAND, ...TOUCH_PORT]) {
    const vp = { w, h };
    const rs = controlRects(true, vp);
    const pedals = rs.find((r) => r.name === '#touch-pedals');
    for (const name of ['.slot-sec2', '.slot-sec3']) {
      const b = rs.find((r) => r.name === name);
      const g = gap(b, pedals);
      if (g < worst) {
        worst = g;
        at = `${name} ${w}×${h}`;
      }
      if (b.x < vp.w / 2) sideOk = false; // 留在右半（踏板那一側），不進左半搖桿區
    }
    const hb = rs.find((r) => r.name === '.slot-sec3');
    if (hb.x + hb.w / 2 < pedals.x + pedals.w / 2) sideOk = false;
  }
  check('駕駛：手煞 / 下車鈕在踏板區外（間距 ≥ 4 px）', worst >= 4, `最小間距 ${worst.toFixed(1)} px @ ${at}`);
  check('駕駛：手煞 / 下車鈕在右半、手煞在油門（右）上方', sideOk);
}

// Phase 2 遺留：寬 < 810 px 橫向時觸控提示與授權標示水平重疊約 4 px → 兩者須完全分離（上下分列）
{
  let worst = Infinity;
  for (const [w, h] of TOUCH_LAND.filter(([w]) => w < 810)) {
    const vp = { w, h };
    const hint = hudRects(true, false, vp, 1).find((r) => r.name === '#touch-hint');
    const attr = attrRect(true, vp);
    worst = Math.min(worst, hint.y - (attr.y + attr.h) >= 0 ? hint.y - (attr.y + attr.h) : attr.y - (hint.y + hint.h));
  }
  check('寬 < 810 px 橫向：觸控提示與授權標示上下分離（間距 ≥ 1 px）', worst >= 1, `最小間距 ${worst.toFixed(1)} px`);
}

// safe-area：所有新 HUD 元素的定位值都帶 env(safe-area-inset-*)（中線定位的 50% 邊除外）
{
  const missing = [];
  for (const id of ['fps', 'hint-card', 'status', 'minimap-wrap', 'drive-panel', 'prompt', 'toast', 'ctrl-hint', 'touch-hint']) {
    for (const chain of [[`#${id}`], [`#${id}`, `body.touch #${id}`]]) {
      for (const vp of [{ w: 844, h: 390 }, { w: 390, h: 844 }]) {
        const d = resolve(chain, vp);
        for (const k of ['left', 'right', 'top', 'bottom']) {
          const v = d[k];
          if (!v || v === 'auto' || /^calc\(50% [+-]/.test(v) || v === '50%') continue;
          if (!/env\(safe-area-inset-/.test(v)) missing.push(`${chain.join(' / ')} ${k}: ${v}`);
        }
      }
    }
  }
  check('新 HUD 元素定位都套 safe-area', !missing.length, missing.slice(0, 3).join('；'));
}

// 觸控鈕 ≥ 44 px（左上小鈕、提示卡關閉鈕）
{
  const tl = resolve(['.tbtn', '.tbtn.slot-tl1']);
  const close = resolve(['#hint-close', 'body.touch #hint-close']);
  check('左上小鈕 ≥ 44 px', px(tl.width) >= 44 && px(tl.height) >= 44, `${tl.width}×${tl.height}`);
  check('觸控提示卡關閉鈕 ≥ 44 px', px(close.width) >= 44 && px(close.height) >= 44, `${close.width}×${close.height}`);
  check('提示卡可點（pointer-events: auto），HUD 其餘不吃指標', rule('#hint-card')['pointer-events'] === 'auto' && rule('#hud')['pointer-events'] === 'none');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} ${fail ? fail : pass}/${pass + fail}`);
if (fail) process.exit(1);
