#!/usr/bin/env node
// 遊戲手把（src/gamepad.js + Input 手把來源）無頭測試：以假 navigator.getGamepads 驅動
// 用法：node tools/test/p8g-gamepad.mjs（任一斷言失敗 exit 1；最後一行 PASS n/n 或 FAIL k/n）
// 涵蓋：無 Gamepad API 不拋例外、左搖桿死區與映射、RT / LT 步行攻擊 / 瞄準與駕駛踏板類比、按下沿只觸發一次、斷線釋放、
//   選單模式合成方向鍵 / Enter（含重複與模式切換鎖鍵）、觸控與手把類比量並存、右搖桿視角倍率 / 反轉 Y、十字鍵武器、震動、說明表 / 設定鍵
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const JSON_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json')) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') + ';' };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(JSON_HOOK)}`, import.meta.url);
globalThis.document = { createElement: () => ({ style: {} }) };

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// mobile.js 載入時判定 hasWindow：先在無 window 下載入模組，再裝 window 替身建構 Input（比照 core.mjs）
const { Input, LOOK_RAD_PER_UNIT } = await import('../../src/input.js');
const gp = await import('../../src/gamepad.js');
const { createGamepad, PAD, MOVE_DEADZONE, LOOK_TURN_RATE, LOOK_PITCH_SCALE, REPEAT_DELAY, REPEAT_INTERVAL, TRIGGER_DEADZONE } = gp;
const { GAMEPAD_HELP, ACTIONS } = await import('../../src/core/actions.js');
const { SETTINGS_SCHEMA } = await import('../../src/core/settings.js');
const { createMenuModel } = await import('../../src/ui/menu-model.js');

// 假 window：記錄 listener 與 dispatch 出去的事件（dispatch 也會送進已註冊的 listener，含 Input 自己的 keydown）
function makeWindow() {
  const L = new Map();
  const sent = [];
  return {
    innerWidth: 1280,
    innerHeight: 720,
    sent,
    addEventListener(name, fn) {
      if (!L.has(name)) L.set(name, []);
      L.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      const a = L.get(name) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    dispatchEvent(ev) {
      sent.push(ev);
      for (const fn of (L.get(ev.type) || []).slice()) fn(ev);
      return true;
    },
    fire(name, ev) {
      for (const fn of (L.get(name) || []).slice()) fn(ev);
    },
  };
}

// 假手把（standard mapping）：buttons[i] = { pressed, value }、axes[4]
function makePad(index = 0, mapping = 'standard') {
  return {
    index,
    id: `fake-${index}`,
    mapping,
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    press(i, v = 1) {
      this.buttons[i] = { pressed: v > 0, value: v };
    },
    up(i) {
      this.buttons[i] = { pressed: false, value: 0 };
    },
  };
}

function setup({ mode = 'walk', slot = null } = {}) {
  const win = makeWindow();
  globalThis.window = win;
  const input = new Input({ addEventListener() {} });
  input.enabled = true;
  const pads = [null, null, null, null];
  const nav = { getGamepads: () => pads };
  const clock = { t: 1000 };
  const ctx = { mode, slot };
  const g = createGamepad(input, {
    navigator: nav,
    window: win,
    KeyboardEvent: null,
    now: () => clock.t,
    getMode: () => ctx.mode,
    getSlot: () => ctx.slot,
  });
  // 一幀：時間前進 ms → endFrame（清 pressed → 手把輪詢 hook）
  const frame = (ms = 16) => {
    clock.t += ms;
    input.endFrame();
  };
  return { win, input, pads, nav, clock, ctx, g, frame };
}

// ======================= 無 Gamepad API =======================
{
  const win = makeWindow();
  globalThis.window = win;
  const input = new Input({ addEventListener() {} });
  let err = null;
  let a, b, c;
  try {
    a = createGamepad(input, { navigator: undefined, window: win });
    b = createGamepad(input, { navigator: {}, window: win });
    c = createGamepad(input, { navigator: { getGamepads: () => { throw new Error('denied'); } }, window: win, KeyboardEvent: null });
    input.enabled = true;
    a.poll();
    b.poll();
    c.poll();
    input.endFrame();
    a.rumble(1, 1, 100);
    a.dispose();
  } catch (e) {
    err = e;
  }
  check('無 navigator / 無 getGamepads / getGamepads 拋例外：不拋例外', !err, err ? String(err) : '');
  check('無 Gamepad API → no-op（supported false）', a && a.supported === false && b.supported === false && c.supported === true && !c.connected);
  // 全域 navigator（node 無 getGamepads）也不拋
  let err2 = null;
  try {
    createGamepad(input).poll();
  } catch (e) {
    err2 = e;
  }
  check('預設全域 navigator（node 無 getGamepads）不拋例外', !err2, err2 ? String(err2) : '');
}

// ======================= 選手把：standard 優先 =======================
{
  const p1 = makePad(0, '');
  const p2 = makePad(1, 'standard');
  check('pickGamepad：standard 優先、否則第一支非 null', gp.pickGamepad([null, p1, p2]) === p2 && gp.pickGamepad([null, p1]) === p1 && gp.pickGamepad([null]) === null && gp.pickGamepad(undefined) === null);
}

// ======================= 左搖桿死區與映射 =======================
{
  const { input, pads, frame } = setup();
  const p = makePad();
  pads[0] = p;
  p.axes[0] = 0.1;
  p.axes[1] = -0.1;
  frame();
  check('左搖桿死區內（0.14）→ 0', input.padStick.x === 0 && input.padStick.y === 0 && input.moveAxis().mag === 0);
  p.axes[0] = MOVE_DEADZONE + (1 - MOVE_DEADZONE) * 0.5;
  p.axes[1] = 0;
  frame();
  check('死區外重新映射：0.575 → 0.5', near(input.padStick.x, 0.5) && near(input.moveAxis().x, 0.5) && input.moveAxis().analog === true);
  p.axes[0] = 0;
  p.axes[1] = -1;
  frame();
  const m = input.moveAxis();
  check('上推到底 → y = 1（前正）、寫入 KeyW 相容鍵', near(m.y, 1) && near(m.x, 0) && input.down('KeyW') && !input.wasPressed('KeyW'));
  p.axes[0] = 1;
  p.axes[1] = -1;
  frame();
  check('斜推到底 → 單位圓內（長度 1）', near(Math.hypot(input.padStick.x, input.padStick.y), 1) && near(input.moveAxis().mag, 1));
  p.axes[0] = 0;
  p.axes[1] = 0;
  frame();
  check('放開 → 歸零、相容鍵放開', input.padStick.x === 0 && !input.down('KeyW') && !input.down('KeyD'));
}

// ======================= RT / LT：步行 = 攻擊 / 瞄準；駕駛 = 踏板類比 =======================
{
  const { input, pads, ctx, frame } = setup();
  const a = input.actions;
  const p = makePad();
  pads[0] = p;
  frame();
  p.press(PAD.RT, 1);
  frame();
  check('步行 RT → Mouse0：down.attack + pressed.attack', a.down('attack') && a.pressed('attack') && input.snapshot().pressed.attack);
  frame();
  check('步行 RT 按住：pressed 只第一幀、down 持續（手槍連發）', a.down('attack') && !a.pressed('attack'));
  p.press(PAD.RT, 0.3);
  frame();
  check('步行 RT 半按（< 0.5）視為放開', !a.down('attack'));
  p.up(PAD.RT);
  p.press(PAD.LT, 1);
  frame();
  check('步行 LT → Mouse2：down.aim', a.down('aim') && input.snapshot().down.aim && input.pedals.brake === 0 && input.padPedals.brake === 0);
  p.up(PAD.LT);
  frame();
  ctx.mode = 'drive';
  p.press(PAD.RT, 0.6);
  frame();
  const thr = (0.6 - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
  check('駕駛 RT 0.6 → 油門類比（死區重映射）、不算攻擊', near(input.padPedals.throttle, thr) && near(input.moveAxis().y, thr) && !a.down('attack') && input.moveAxis().analog);
  p.press(PAD.LT, 1);
  frame();
  check('駕駛 RT 0.6 + LT 1 → y = throttle − brake', near(input.moveAxis().y, thr - 1) && !a.down('aim'));
  p.up(PAD.RT);
  frame();
  check('駕駛只踩 LT → 倒車 y = −1', near(input.moveAxis().y, -1));
  p.up(PAD.LT);
  p.axes[0] = 1;
  frame();
  const dm = input.moveAxis();
  check('駕駛左搖桿 → 轉向 x = 1、只寫 KeyD 不寫 KeyW', near(dm.x, 1) && input.down('KeyD') && !input.down('KeyW'));
  p.axes[0] = 1;
  p.press(PAD.RT, 1);
  frame();
  const fm = input.moveAxis();
  check('駕駛全油門轉彎：兩軸各自 ±1（不被單位圓壓成 0.71）', near(fm.x, 1) && near(fm.y, 1));
  p.press(PAD.X);
  frame();
  check('駕駛 X → KeyH 喇叭；步行 X → KeyR 裝填', a.down('horn') && !input.down('KeyR'));
  p.up(PAD.X);
  frame();
  ctx.mode = 'walk';
  frame(); // 切換幀：當下按住的鍵鎖到放開（RT 仍按著），X 在切換後才按
  p.press(PAD.X);
  frame();
  check('步行 X → pressed.reload', a.pressed('reload') && !input.down('KeyH'));
}

// ======================= 按下沿只觸發一次 / 配置 =======================
{
  const { input, pads, ctx, frame } = setup({ slot: 0 });
  const p = makePad();
  pads[0] = p;
  frame();
  p.press(PAD.A);
  frame();
  const first = input.wasPressed('Space');
  frame();
  const second = input.wasPressed('Space');
  frame();
  check('A 按住：pressed 只第一幀、down 持續', first && !second && !input.wasPressed('Space') && input.down('Space'));
  p.up(PAD.A);
  frame();
  check('A 放開 → Space 放開', !input.down('Space'));
  p.press(PAD.A);
  frame();
  check('再按 A → 再一次 pressed', input.wasPressed('Space'));
  p.up(PAD.A);
  const map = [
    [PAD.B, 'interact'],
    [PAD.Y, 'enterExit'],
    [PAD.LB, 'weaponCycle'],
    [PAD.RB, 'camera'],
    [PAD.BACK, 'map'],
    [PAD.START, 'pause'],
    [PAD.UP, 'phone'],
    [PAD.DOWN, 'timeSkip'],
    [PAD.RIGHT, 'weaponCycle'],
  ];
  const bad = [];
  for (const [i, action] of map) {
    frame();
    p.press(i);
    frame();
    if (!input.actions.pressed(action)) bad.push(`${i}→${action}`);
    p.up(i);
    frame();
    input.enabled = true; // Start（pause）等不會自己停用；保險
  }
  check('按鍵配置：B 互動 / Y 上下車 / LB 循環 / RB 鏡頭 / Back 地圖 / Start 暫停 / ↑ 手機 / ↓ 快轉 / → 下一把', bad.length === 0, bad.join(','));
  p.press(PAD.L3);
  p.press(PAD.R3);
  frame();
  frame();
  check('L3 → 衝刺按住、R3 → 回頭看按住', input.actions.down('sprint') && input.actions.down('lookBack') && input.snapshot().down.sprint);
  p.up(PAD.L3);
  p.up(PAD.R3);
  frame();
  ctx.slot = 0;
  p.press(PAD.LEFT);
  frame();
  check('步行 ←（目前 slot 0）→ Digit3 直選上一把', input.actions.pressed('slot3'));
  p.up(PAD.LEFT);
  frame();
  ctx.slot = 2;
  p.press(PAD.LEFT);
  frame();
  check('步行 ←（目前 slot 2）→ Digit2', input.actions.pressed('slot2'));
  p.up(PAD.LEFT);
  frame();
  ctx.mode = 'drive';
  p.press(PAD.LEFT);
  frame();
  check('駕駛中 ← 不送武器鍵', !input.actions.pressed('slot1') && !input.actions.pressed('slot2') && !input.actions.pressed('slot3') && !input.down('KeyQ'));
  p.up(PAD.LEFT);
  frame();
  p.press(PAD.LB);
  frame();
  check('駕駛 LB → KeyQ = radioNext（CONTEXT_ACTIONS）', input.actions.pressedIn('radioNext', 'vehicle') && !input.actions.pressedIn('weaponCycle', 'vehicle'));
}

// ======================= 斷線釋放 =======================
{
  const { input, pads, win, frame } = setup();
  const p = makePad();
  pads[0] = p;
  frame();
  p.press(PAD.A);
  p.press(PAD.RT);
  p.press(PAD.L3);
  p.axes[0] = 1;
  p.axes[2] = 1;
  frame();
  frame();
  const before = input.down('Space') && input.down('Mouse0') && input.down('ShiftLeft') && input.padStick.x === 1 && input.dx > 0;
  pads[0] = null;
  win.fire('gamepaddisconnected', { gamepad: p });
  check('斷線事件 → 釋放所有按住鍵、搖桿 / 視角歸零', before && input.padKeys.size === 0 && !input.down('Space') && !input.down('Mouse0') && !input.down('ShiftLeft') && input.padStick.x === 0 && input.dx === 0 && input.dy === 0 && input.moveAxis().mag === 0);
  frame();
  check('斷線後輪詢不到手把 → 不殘留', input.keys.size === 0 && input.padKeys.size === 0);
  // 無事件、輪詢直接取不到（部分瀏覽器）也要釋放；駕駛踏板也歸零
  pads[0] = p;
  frame();
  input.dx = 0;
  frame();
  p.up(PAD.A);
  p.up(PAD.RT);
  p.up(PAD.L3);
  frame();
  p.press(PAD.B);
  p.axes[0] = -1;
  frame();
  const held = input.down('KeyE') && input.down('KeyA');
  pads[0] = null;
  frame();
  check('輪詢取不到（無斷線事件）→ 同樣釋放', held && !input.down('KeyE') && !input.down('KeyA') && input.padStick.x === 0);
  input.dx = 5;
  frame();
  check('沒有手把時不會每幀清掉滑鼠視角量', input.dx === 5);
}

// ======================= 選單模式：合成方向鍵 / Enter / Escape =======================
{
  const { input, pads, win, frame } = setup();
  input.enabled = false;
  const model = createMenuModel();
  model.showStart({ canContinue: false });
  const fx = [];
  // 模擬 menu.js：window keydown → model.key(e.code)；開始效果 → 整合層 input.enabled = true
  win.addEventListener('keydown', (e) => {
    const r = model.key(e.code);
    if (r) fx.push(r);
    if (r && r.type === 'start') input.enabled = true;
  });
  const p = makePad();
  pads[0] = p;
  frame();
  const keydowns = () => win.sent.filter((e) => e.type === 'keydown').map((e) => e.code + (e.repeat ? '*' : ''));
  p.press(PAD.DOWN);
  frame();
  check('選單：十字鍵 ↓ → 合成 ArrowDown（keydown + keyup）', keydowns().join() === 'ArrowDown' && win.sent.some((e) => e.type === 'keyup' && e.code === 'ArrowDown'));
  frame(REPEAT_DELAY - 50);
  check('按住未滿 400 ms 不重複', keydowns().length === 1);
  frame(60);
  check('按住滿 400 ms → 重複（repeat: true）', keydowns().join() === 'ArrowDown,ArrowDown*');
  frame(REPEAT_INTERVAL);
  check('之後每 120 ms 一次', keydowns().length === 3);
  frame(50);
  check('間隔內不重複', keydowns().length === 3);
  p.up(PAD.DOWN);
  frame();
  p.axes[1] = -0.8;
  frame();
  check('左搖桿上推 → ArrowUp', keydowns().at(-1) === 'ArrowUp');
  p.axes[1] = 0;
  p.axes[0] = 0.9;
  frame();
  check('左搖桿右推 → ArrowRight', keydowns().at(-1) === 'ArrowRight');
  p.axes[0] = 0;
  frame();
  check('選單模式不寫入遊戲輸入（padKeys 空、無 pressed）', input.padKeys.size === 0 && input.pressed.size === 0 && input.moveAxis().mag === 0);
  // 回到預設焦點後按 A 開始遊戲
  model.showStart({ canContinue: false });
  win.sent.length = 0;
  p.press(PAD.A);
  frame();
  check('選單：A → Enter → 開始遊戲（menu-model start 效果）', keydowns().join() === 'Enter' && fx.at(-1).type === 'start' && input.enabled);
  frame();
  frame();
  check('開始遊戲時仍按著 A：進遊戲後不變成跳（鎖到放開）', !input.down('Space') && !input.wasPressed('Space'));
  p.up(PAD.A);
  frame();
  p.press(PAD.A);
  frame();
  check('放開再按 A → 遊戲中正常跳', input.wasPressed('Space'));
  p.up(PAD.A);
  frame();
  // 遊戲中按 Start → pause（整合層停用 input）；選單內仍按著 Start 不送 Escape，放開再按才送
  p.press(PAD.START);
  frame();
  const paused = input.actions.pressed('pause');
  input.enabled = false; // main.js：menu.openPause → pauseGame
  win.sent.length = 0;
  frame();
  frame();
  check('遊戲中 Start → pause；開選單時仍按著不會再送 Escape', paused && keydowns().length === 0 && input.padKeys.size === 0);
  p.up(PAD.START);
  frame();
  p.press(PAD.B);
  frame();
  p.up(PAD.B);
  frame();
  p.press(PAD.START);
  frame();
  p.up(PAD.START);
  frame();
  check('選單：B = Escape、Start = Escape', keydowns().join() === 'Escape,Escape');
  // Input 自己的 keydown listener 在停用中不吃合成鍵
  check('合成鍵不進 Input（停用中）', input.kbKeys.size === 0 && input.pressed.size === 0);
}

// ======================= 觸控與手把並存 =======================
{
  const { input, pads, frame } = setup();
  const p = makePad();
  pads[0] = p;
  frame();
  input.setStick(0.3, 0.4); // 觸控搖桿
  frame();
  check('手把閒置：觸控搖桿照常（不被手把 0 蓋掉）', near(input.moveAxis().x, 0.3) && near(input.moveAxis().y, 0.4) && input.stick.x === 0.3);
  p.axes[0] = -1;
  frame();
  const m = input.moveAxis();
  check('每軸取絕對值較大者：x 取手把 −1、y 保留觸控 0.4', m.x < -0.9 && m.y > 0.3);
  check('手把輸入不改寫觸控 stick 本身', input.stick.x === 0.3 && input.stick.y === 0.4);
  p.axes[0] = 0;
  frame();
  check('手把放開 → 回到觸控值', near(input.moveAxis().x, 0.3) && near(input.moveAxis().y, 0.4));
  input.setStick(0, 0);
  // 觸控為 drive、main.js mode 仍是 walk：手把 RT 0.4 依步行解讀（< 0.5 不攻擊、不進踏板），觸控踏板照常
  input.setTouchMode('drive');
  p.press(PAD.RT, 0.4);
  frame();
  input.setPedals(0.8, 0);
  check('觸控踏板 0.8 不被手把蓋掉', near(input.moveAxis().y, 0.8) && input.padPedals.throttle === 0 && !input.actions.down('attack'));
}
{
  const { input, pads, frame } = setup({ mode: 'drive' });
  const p = makePad();
  pads[0] = p;
  input.setTouchMode('drive');
  input.setPedals(0.8, 0);
  p.press(PAD.RT, 0.4);
  frame();
  const rt = (0.4 - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
  check('駕駛：觸控油門 0.8 + 手把 RT 0.37 → 取較大 0.8', near(input.moveAxis().y, 0.8) && near(input.padPedals.throttle, rt));
  input.setPedals(0, 0);
  check('觸控油門放開 → 手把 RT 值', near(input.moveAxis().y, rt));
  input.setStick(-0.2, 0);
  p.axes[0] = 0.6;
  frame();
  check('駕駛轉向：觸控 −0.2 vs 手把 0.53 → 取手把', near(input.moveAxis().x, (0.6 - MOVE_DEADZONE) / (1 - MOVE_DEADZONE)));
  p.axes[0] = 0;
  frame();
  check('手把轉向放開 → 觸控 −0.2', near(input.moveAxis().x, -0.2));
  input.enabled = false;
  check('停用 → 手把與觸控類比量全清', input.padPedals.throttle === 0 && input.pedals.throttle === 0 && input.padKeys.size === 0 && input.stick.x === 0);
}

// ======================= 右搖桿視角 =======================
{
  const { input, pads, frame } = setup();
  const p = makePad();
  pads[0] = p;
  frame();
  input.dx = 0;
  input.dy = 0;
  p.axes[2] = 0.1;
  frame(100);
  check('右搖桿死區內（0.1 < 0.12）→ 不轉', input.dx === 0 && input.dy === 0);
  p.axes[2] = 1;
  frame(100);
  const full = (LOOK_TURN_RATE / LOOK_RAD_PER_UNIT) * 0.1;
  check('右推到底 100 ms → dx = 225°/s × 0.1 s（滑鼠單位）', near(input.dx, full, 1e-6), `${input.dx} vs ${full}`);
  input.dx = 0;
  p.axes[2] = 0.12 + 0.88 * 0.5;
  frame(100);
  check('半推 → 非線性（平方曲線 = 1/4 速）', near(input.dx, full * 0.25, 1e-6), `${input.dx}`);
  input.dx = 0;
  p.axes[2] = 0;
  p.axes[3] = 1;
  frame(100);
  const dy1 = input.dy;
  check('下推 → dy 正（同滑鼠往下）、垂直比例 0.65', near(dy1, full * LOOK_PITCH_SCALE, 1e-6));
  input.dy = 0;
  input.setInvertY(true);
  frame(100);
  check('反轉 Y → dy 反號', near(input.dy, -dy1, 1e-6));
  input.setInvertY(false);
  input.dy = 0;
  input.setSensitivity({ pad: 2 });
  frame(100);
  check('lookSensPad 倍率 2 → 視角量 ×2；滑鼠 / 觸控倍率不變', near(input.dy, dy1 * 2, 1e-6) && input.sens.mouse === 1 && input.sens.touch === 1);
  input.dy = 0;
  frame(5000);
  check('單幀 dt 上限 0.1 s（切背景回來不暴衝）', near(input.dy, dy1 * 2, 1e-6));
}

// ======================= 純鍵盤 / 滑鼠行為不變 =======================
{
  const { input, pads, win, frame } = setup();
  const p = makePad();
  pads[0] = p;
  frame();
  win.fire('keydown', { code: 'KeyW', repeat: false, preventDefault() {} });
  win.fire('keydown', { code: 'KeyD', repeat: false, preventDefault() {} });
  const m = input.moveAxis();
  check('手把接著但閒置：鍵盤 W + D 仍正規化到單位圓（0.71）', near(m.x, Math.SQRT1_2) && near(m.y, Math.SQRT1_2) && m.analog === false);
  frame();
  check('手把輪詢不會放開鍵盤按住的鍵', input.down('KeyW') && input.down('KeyD'));
  p.press(PAD.A);
  frame();
  p.up(PAD.A);
  frame();
  check('手把放開 Space 不影響鍵盤 W', input.down('KeyW') && !input.down('Space'));
  const st = setup({ mode: 'drive' });
  st.win.fire('keydown', { code: 'KeyW', repeat: false, preventDefault() {} });
  st.win.fire('keydown', { code: 'KeyD', repeat: false, preventDefault() {} });
  const dm = st.input.moveAxis();
  check('無手把、桌機駕駛：鍵盤 W + D 行為不變（走單位圓分支）', near(dm.x, Math.SQRT1_2) && near(dm.y, Math.SQRT1_2));
}

// ======================= onFrame 與多個 hook 並存 =======================
{
  const { input } = setup();
  let touchCalls = 0;
  let hookCalls = 0;
  input.onFrame = () => touchCalls++;
  const off = input.addFrameHook(() => hookCalls++);
  input.endFrame();
  off();
  input.endFrame();
  check('onFrame（觸控）與 addFrameHook 並存、可取消訂閱', touchCalls === 2 && hookCalls === 1);
}

// ======================= 震動 =======================
{
  const { pads, g, frame } = setup();
  check('沒有手把 → rumble 回 false', g.rumble(1, 1, 100) === false);
  const p = makePad();
  pads[0] = p;
  frame();
  check('手把沒有 vibrationActuator → 略過（false、不拋）', g.rumble(1, 1, 100) === false);
  const calls = [];
  p.vibrationActuator = { playEffect: (type, params) => (calls.push([type, params]), Promise.resolve('complete')) };
  frame();
  const ok = g.rumble(0.2, 0.6, 70);
  check('有 vibrationActuator → playEffect dual-rumble', ok && calls.length === 1 && calls[0][0] === 'dual-rumble' && calls[0][1].duration === 70 && calls[0][1].strongMagnitude === 0.2);
  p.vibrationActuator = { playEffect: () => { throw new Error('x'); } };
  frame();
  check('playEffect 拋例外 → 回 false 不拋', g.rumble(1, 1, 10) === false);
  g.dispose();
}

// ======================= 審查修正：切換鎖鍵 / 遲滯 / 重複卡頓 / 面板 / 武器槽 =======================
{
  // 步行 / 駕駛切換鎖鍵：駕駛中按住 RT / LT（踏板），下車回步行不得立刻變成按住 Mouse0 / Mouse2
  const { input, pads, ctx, frame } = setup({ mode: 'drive' });
  const p = makePad();
  pads[0] = p;
  frame();
  p.press(PAD.RT, 1);
  p.press(PAD.LT, 1);
  frame();
  const drove = input.padPedals.throttle === 1 && input.padPedals.brake === 1;
  ctx.mode = 'walk';
  frame();
  check('駕駛 → 步行：仍按著 RT / LT 不會變成 Mouse0 / Mouse2 按住', drove && !input.down('Mouse0') && !input.down('Mouse2') && !input.actions.down('attack') && !input.padKeys.has('Mouse0'));
  frame();
  check('鎖鍵期間持續按著仍不生效', !input.down('Mouse0') && !input.down('Mouse2'));
  p.up(PAD.RT);
  p.up(PAD.LT);
  frame();
  p.press(PAD.RT, 1);
  frame();
  check('放開後重新按 RT → 正常 Mouse0 按下沿', input.down('Mouse0') && input.actions.pressed('attack'));
  // 反向：步行按住 RT 上車 → 駕駛油門不受鎖鍵影響（踏板走 raw）
  ctx.mode = 'drive';
  frame();
  check('步行 → 駕駛：踏板類比不受鎖鍵影響', input.padPedals.throttle === 1 && !input.down('Mouse0'));
}
{
  // 扳機遲滯：按下 0.5、放開 0.4
  const { input, pads, frame } = setup();
  const p = makePad();
  pads[0] = p;
  frame();
  let edges = 0;
  for (const v of [0.51, 0.49, 0.51, 0.49, 0.51]) {
    p.press(PAD.RT, v);
    frame();
    if (input.actions.pressed('attack')) edges++;
  }
  check('RT 在 0.49 / 0.51 抖動 → 只有 1 次按下沿、仍按住', edges === 1 && input.down('Mouse0'));
  p.press(PAD.RT, 0.41);
  frame();
  const still = input.down('Mouse0');
  p.press(PAD.RT, 0.39);
  frame();
  check('已按住 0.41 仍按住、< 0.4 才放開', still && !input.down('Mouse0'));
  p.press(PAD.RT, 0.45);
  frame();
  check('放開後要回到 ≥ 0.5 才再按下', !input.down('Mouse0'));
}
{
  const { input, pads, win, clock, frame } = setup();
  const p = makePad();
  pads[0] = p;
  frame();
  input.enabled = false;
  frame();
  win.sent.length = 0;
  const times = [];
  const t0 = clock.t;
  const mark = () => {
    for (const ev of win.sent.splice(0)) if (ev.type === 'keydown') times.push(clock.t - t0);
  };
  p.press(PAD.DOWN);
  frame();
  mark();
  frame(REPEAT_DELAY);
  mark();
  frame(REPEAT_INTERVAL * 3); // 卡頓（掉幀 360 ms）
  mark();
  frame(16);
  mark();
  frame(16);
  mark();
  let minGap = Infinity;
  for (let i = 2; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
  check('選單方向鍵卡頓後不連發（重複間隔皆 ≥ 120 ms）', times.length >= 3 && minGap >= REPEAT_INTERVAL, `keydown 時間 ${times.join(',')}`);
}
{
  // 任務面板（keydown 掛 keyTarget）：手把 A / B 的合成鍵要到得了
  const { createMissionUi } = await import('../../src/missions/ui.js');
  const mkEl = () => {
    const e = {
      children: [],
      style: {},
      dataset: {},
      attrs: {},
      listeners: {},
      hidden: false,
      get firstChild() {
        return this.children[0] || null;
      },
      append(...k) {
        this.children.push(...k);
      },
      appendChild(k) {
        this.children.push(k);
        return k;
      },
      removeChild(k) {
        this.children.splice(this.children.indexOf(k), 1);
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      addEventListener(n, fn) {
        (this.listeners[n] || (this.listeners[n] = [])).push(fn);
      },
      focus() {},
      click() {
        for (const fn of this.listeners.click || []) fn({});
      },
    };
    return e;
  };
  const run = (useKeyTarget) => {
    const { win, input, pads, frame } = setup();
    const doc = { createElement: mkEl, body: mkEl(), listeners: {}, addEventListener(n, fn) { (this.listeners[n] || (this.listeners[n] = [])).push(fn); } };
    const actions = [];
    const ui = createMissionUi({ root: doc.body, doc, keyTarget: useKeyTarget ? win : null, onAction: (a) => actions.push(a) });
    ui.showOffer({ title: 't', name: 'n', slug: 's', conditions: [], reward: 100, brief: '' }, { timeLimitSec: 0, fromName: 'a', toName: 'b' });
    input.enabled = false; // 面板開著 → main.js 停用 input → 手把進選單模式
    const p = makePad();
    pads[0] = p;
    frame();
    p.press(PAD.A);
    frame();
    p.up(PAD.A);
    frame();
    // 真實瀏覽器：送到 window 的事件不會到 document；fake window 同樣只通知 window listener
    return { actions, ui, p, frame };
  };
  const fixed = run(true);
  check('任務面板開著：手把 A（Enter）→ primary（keyTarget: window）', fixed.actions.join() === 'accept');
  fixed.ui.showOffer({ title: 't', name: 'n', slug: 's', conditions: [], reward: 100, brief: '' }, { timeLimitSec: 0, fromName: 'a', toName: 'b' });
  fixed.p.press(PAD.B);
  fixed.frame();
  check('任務面板開著：手把 B（Escape）→ secondary', fixed.actions.join() === 'accept,decline');
  const broken = run(false);
  check('對照：面板預設掛 document 時 window 合成鍵收不到（所以 main.js 必須傳 keyTarget: window）', broken.actions.length === 0);
  const mainSrc = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  check('main.js createMissions 傳 keyTarget: window', /createMissions\(\{\s*(?:\/\/[^\n]*\n\s*)*keyTarget: window,/.test(mainSrc));
  check('main.js getSlot 看 weapons.pending（排隊中優先）', /getSlot: \(\) => \(weapons\.pending >= 0 \? weapons\.pending : weapons\.slot\)/.test(mainSrc));
}

{
  // padDrive 依模式穩定：駕駛中鍵盤 W + D 不隨手把類比量（0 → 0.08）在單位圓 / 駕駛分支間跳動
  const { input, pads, win, ctx, frame } = setup({ mode: 'drive' });
  const p = makePad();
  pads[0] = p;
  frame();
  win.fire('keydown', { code: 'KeyW', repeat: false, preventDefault() {} });
  win.fire('keydown', { code: 'KeyD', repeat: false, preventDefault() {} });
  const idle = input.moveAxis();
  p.press(PAD.RT, 0.08);
  frame();
  const small = input.moveAxis();
  check('駕駛 + 手把接著：W + D 在手把閒置 / 微量 RT 時結果相同（不閃爍）', input.padDrive === true && near(idle.x, small.x) && near(idle.y, small.y) && near(idle.x, 1) && near(idle.y, 1));
  ctx.mode = 'walk';
  p.up(PAD.RT);
  frame();
  const w = input.moveAxis();
  check('步行 + 手把接著：padDrive = false，W + D 回到單位圓', input.padDrive === false && near(w.x, Math.SQRT1_2) && near(w.y, Math.SQRT1_2));
}

// ======================= 說明表 / 設定 =======================
{
  const okShape = Array.isArray(GAMEPAD_HELP) && GAMEPAD_HELP.every((grp) => ['步行', '駕駛', '通用'].includes(grp.group) && grp.items.every((it) => typeof it.keys === 'string' && typeof it.desc === 'string' && (it.action === null || ACTIONS[it.action])));
  check('GAMEPAD_HELP 結構同 TOUCH_HELP（步行 / 駕駛 / 通用）', okShape && GAMEPAD_HELP.map((grp) => grp.group).join() === '步行,駕駛,通用');
  const s = SETTINGS_SCHEMA.lookSensPad;
  check('settings.lookSensPad：0.3–3.0 step 0.1 預設 1（同滑鼠）', s && s.min === SETTINGS_SCHEMA.lookSensMouse.min && s.max === SETTINGS_SCHEMA.lookSensMouse.max && s.step === 0.1 && s.default === 1);
}

delete globalThis.window;
console.log(`${failed ? 'FAIL' : 'PASS'} ${failed ? failed : passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
