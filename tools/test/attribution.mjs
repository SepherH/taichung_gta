// 授權標示（#attribution）無頭檢查：解析 src/style.css 與 index.html，確認 ODbL 標示貼角落、小字半透明、不吃指標事件且只有一處
// 另檢查 #help / #ctrl-hint 的揮拳說明已改為「E / 滑鼠左鍵」。用法：node tools/test/attribution.mjs（任一斷言失敗 exit 1）
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

// 取出選擇器完全等於 selector 的規則，合併其宣告（同名屬性後者覆蓋）
function rule(selector) {
  const decl = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return decl;
}

const base = rule('#attribution');
const touch = rule('body.touch #attribution');
const px = (v) => parseFloat(v);

check('#attribution 規則存在', Object.keys(base).length > 0);
check('position: fixed', base.position === 'fixed', base.position);
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

check('觸控版規則存在', Object.keys(touch).length > 0);
check('觸控版 bottom 以 env(safe-area-inset-bottom) 定位', /env\(safe-area-inset-bottom\)/.test(touch.bottom || ''), touch.bottom);
check('觸控版 left 以 env(safe-area-inset-left) 定位', /env\(safe-area-inset-left\)/.test(touch.left || ''), touch.left);
check('觸控版字級 10–11 px', px(touch['font-size']) >= 10 && px(touch['font-size']) <= 11, touch['font-size']);

// 桌機：與右下 #ctrl-hint / #speed 底緣比對（標示頂緣須低於兩者底緣）
const attrTop = px(base.bottom.match(/calc\((\d+)px/)[1]) + px(base['font-size']) * px(base['line-height']);
const hintBottom = px(rule('#ctrl-hint').bottom);
const speedBottom = px(rule('#speed').bottom);
check('桌機標示頂緣低於 #ctrl-hint / #speed 底緣', attrTop < Math.min(hintBottom, speedBottom), `${attrTop.toFixed(1)} < ${Math.min(hintBottom, speedBottom)}`);

// 載入畫面上連結可點
check('載入畫面另設 pointer-events: auto', rule('#loading:not(.hidden) ~ #attribution')['pointer-events'] === 'auto');

// index.html：只有一個 #attribution，連結文字完整
const ids = html.match(/id="attribution"/g) || [];
check('index.html 只有一個 #attribution', ids.length === 1, `${ids.length} 個`);
check('連結文字「OpenStreetMap contributors」保留', />OpenStreetMap contributors<\/a>/.test(html));
check('「ODbL」保留', /id="attribution"[^\n]*ODbL/.test(html));
check('#loading 位於 #attribution 之前（~ 選擇器生效）', html.indexOf('id="loading"') < html.indexOf('id="attribution"'));

// 揮拳說明
check('#help 不再註記左鍵需鎖定', !/需先?鎖定滑鼠）/.test(html));
check('#help 含「E / 滑鼠左鍵：揮拳」', /<b>E<\/b> \/ <b>滑鼠左鍵<\/b>：揮拳/.test(html));
check('#ctrl-hint 同步含滑鼠左鍵揮拳', /id="ctrl-hint"><b>E<\/b> \/ <b>滑鼠左鍵<\/b> 揮拳/.test(html));

console.log(`\n通過 ${pass} / ${pass + fail}`);
if (fail) process.exit(1);
