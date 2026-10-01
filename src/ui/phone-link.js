// 遊戲內手機接線（I6b，契約 §23.3）：main.js 與 ui/phone.js 之間的開關互斥、輸入鎖定與每幀資料注入
// 依賴全部注入（phone / input / 狀態查詢 / 資料來源），不 import main / missions，tools/test/p6-i6b.mjs 以假物件直接測
//   canOpenPhone(s)：只在 started && !paused && !panelOpen && !menuOpen && !blocked 時可開（§23.3 互斥）
//   createPhoneLink({ phone, input, canOpen, canResume, onLock, fillData }) →
//     open()：可開才 setData（先填一次資料再 open，鎖屏時鐘不閃 --:--）→ phone.open() → sync()（同步鎖輸入）；回傳是否開了
//     toggle()：開著 → close（之後 sync 還原輸入）；關著 → open()
//     sync()：phone.isOpen() 轉真 → input.enabled = false + onLock()（放開滑鼠鎖定、駕駛中手煞）；
//             轉假 → canResume() 為真才 input.enabled = true（暫停中 / 面板開著時交給選單 / syncPanels 還原）；回傳是否開著
//     frame(dt)：開著才 fillData + setData（listings 每幀重用同一陣列），phone.update(dt)（渲染 dt，§20）
//     reset()：新局 / 回主選單 / 暫停時關手機並忘記上次狀態（不動 input.enabled，由呼叫端決定）
// 手機不暫停世界（不列入 main.js panelOpen）：鎖輸入只靠 input.enabled = false（清空按住狀態並釋放觸控指標，input.js）
// sync 只在幀內 / 明確呼叫時跑，不掛在 phone:close 事件上——Esc / T 在 keydown capture 內關手機時若同步把 input.enabled 設回真，
//   同一個 keydown 會再被 input.js 收到（Esc → 暫停選單）
export function canOpenPhone(s) {
  return !!(s && s.started && !s.paused && !s.panelOpen && !s.menuOpen && !s.blocked);
}

export function createPhoneLink({ phone, input, canOpen = () => true, canResume = () => true, onLock = () => {}, fillData = null } = {}) {
  const data = { hour: NaN, weatherIcon: '', money: undefined, jobs: null };
  let was = false;

  const refresh = () => {
    if (typeof fillData === 'function') fillData(data);
    phone.setData(data);
  };

  function sync() {
    const open = !!phone.isOpen();
    if (open === was) return open;
    was = open;
    if (open) {
      input.enabled = false;
      onLock();
    } else if (canResume()) input.enabled = true;
    return open;
  }

  function open() {
    if (phone.isOpen() || !canOpen()) return false;
    refresh();
    phone.open();
    sync();
    return phone.isOpen();
  }

  return {
    open,
    toggle() {
      if (phone.isOpen()) {
        phone.close();
        sync();
        return false;
      }
      return open();
    },
    sync,
    frame(dt) {
      if (phone.isOpen()) refresh();
      phone.update(dt);
    },
    reset() {
      phone.close();
      was = false;
    },
    get data() {
      return data;
    },
  };
}
