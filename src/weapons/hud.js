// 武器 HUD（契約 §12 / §13，前綴 wp-，z-index 50–59）：右上武器圖示 + 彈藥「12 / 36」+ 裝填進度、畫面中央準星
//   （持手槍顯示、瞄準時收窄）、觸控武器鈕 tb-weapon（點擊循環 / 長按三格輪盤）、tb-reload / tb-aim（持手槍才顯示）
// createWeaponHud({ root, touchRoot?, weapons, input?, isTouch?, imgBase = 'art/hud/', onCycle?, onSelect?, onReload? })
//   → { update(dt, state), setDriving(bool), setVisible(bool), isWheelOpen(), aimHeld, dispose(), el, keys（桌機鍵位提示，觸控 null） }
//   root：HUD 容器（例 document.body 或 #hud）；touchRoot：觸控層 #touch-ui（isTouch 時才建按鈕）
//   state：{ driving?, aimBlend?（camera rig.aimBlend，0..1） }；每幀呼叫，只有值變了才寫 DOM（不配置新物件）
//   圖示 art/hud/weapon-<id>.png 缺檔 → 顯示文字名稱（onerror 退回，只 console.info 一次）
//   按鈕預設動作：tb-weapon 點擊 = weapons.cycle()、輪盤選格 = weapons.select(slot)、tb-reload = weapons.reload()、
//     tb-aim 按住 = input.touchPress('Mouse2', true) / touchRelease（沒給 input 時改讀 hud.aimHeld）；可用 onCycle / onSelect / onReload 覆寫
//   觸控按鈕 ≥ 44 px、safe-area；駕駛中（setDriving(true) 或 body.touch-drive）全部隱藏
//   桌機（非觸控）面板另列換武器鍵位提示 .wp-keys（鍵位讀 core/actions.js 的 ACTIONS：weaponCycle、slot1–3；目前槽加 .wp-cur 並加粗），駕駛中隱藏
//   觸控版面（body.touch，weapons.css）：面板縮為一列放 #status 下方（直向在新手提示卡下方、高 < 380 橫向在 #status 上方），
//     三鈕排在攻擊鈕周圍（矮橫向 ≤ 540：武器 / 瞄準在互動鈕下方、裝填在右上角）；駕駛中面板一併隱藏
import './weapons.css';
import { WEAPONS, SLOT_IDS } from './defs.js';
import { ACTIONS } from '../core/actions.js';
import { LONG_PRESS_MS, classifyPress, wheelSlotFromVector, wheelCellOffset, ammoText } from './wheel.js';

let iconInfoShown = false;

function el(doc, tag, cls, id) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (id) e.id = id;
  return e;
}

function toggle(e, cls, on) {
  if (e.classList) e.classList.toggle(cls, !!on);
}

// KeyboardEvent.code → 顯示用鍵名（KeyQ → Q、Digit1 → 1）
const keyName = (code) => String(code).replace(/^Key|^Digit/, '');

// 桌機換武器鍵位提示：[{ text, slot }]（slot -1 = 循環鍵）；鍵位單一來源 ACTIONS
export function weaponKeyHints() {
  const out = [{ text: `${ACTIONS.weaponCycle.keys.map(keyName).join('/')} 換武器`, slot: -1 }];
  SLOT_IDS.forEach((id, i) => {
    const a = ACTIONS[`slot${i + 1}`];
    if (a) out.push({ text: `${a.keys.map(keyName).join('/')} ${WEAPONS[id].label}`, slot: i });
  });
  return out;
}

export function createWeaponHud({
  root,
  touchRoot = null,
  weapons,
  input = null,
  isTouch = false,
  imgBase = 'art/hud/',
  onCycle = null,
  onSelect = null,
  onReload = null,
} = {}) {
  const doc = root.ownerDocument || globalThis.document;
  const touch = typeof isTouch === 'function' ? !!isTouch() : !!isTouch;
  const cycle = onCycle || (() => weapons.cycle());
  const select = onSelect || ((s) => weapons.select(s));
  const reload = onReload || (() => weapons.reload());

  // ---------- 右上面板 ----------
  const panel = el(doc, 'div', 'wp-hud', 'wp-hud');
  const icon = el(doc, 'img', 'wp-icon');
  icon.alt = '';
  const name = el(doc, 'span', 'wp-name');
  const ammo = el(doc, 'span', 'wp-ammo');
  const bar = el(doc, 'div', 'wp-reload');
  const fill = el(doc, 'div', 'wp-reload-fill');
  bar.appendChild(fill);
  panel.appendChild(icon);
  panel.appendChild(name);
  panel.appendChild(ammo);
  panel.appendChild(bar);
  // 桌機鍵位提示（觸控已有 tb-weapon，不建）；樣式內嵌（weapons.css 不動）
  const keys = touch ? null : el(doc, 'span', 'wp-keys');
  const keyCells = [];
  if (keys) {
    Object.assign(keys.style, { display: 'flex', gap: '6px', fontSize: '0.72em', fontWeight: 'normal', opacity: '0.85', whiteSpace: 'nowrap' });
    for (const h of weaponKeyHints()) {
      const k = el(doc, 'span', 'wp-key');
      k.textContent = h.text;
      keys.appendChild(k);
      if (h.slot >= 0) keyCells[h.slot] = k;
    }
    panel.appendChild(keys);
  }
  root.appendChild(panel);

  // 圖示：各武器一次載入結果（true = 可用、false = 缺檔、undefined = 尚未知）
  const iconOk = {};
  let iconFor = null;
  icon.onerror = () => {
    if (iconFor) iconOk[iconFor] = false;
    icon.hidden = true;
    name.hidden = false;
    if (!iconInfoShown) {
      iconInfoShown = true;
      console.info('武器圖示缺檔，改用文字');
    }
  };
  icon.onload = () => {
    if (iconFor) iconOk[iconFor] = true;
    icon.hidden = false;
    name.hidden = true;
  };

  // ---------- 準星 ----------
  const cross = el(doc, 'div', 'wp-crosshair', 'wp-crosshair');
  for (const k of ['t', 'b', 'l', 'r']) cross.appendChild(el(doc, 'i', `wp-ch wp-ch-${k}`));
  cross.appendChild(el(doc, 'i', 'wp-ch-dot'));
  root.appendChild(cross);

  // ---------- 觸控 ----------
  const buttons = [];
  let btnWeapon = null;
  let btnLabel = null;
  let btnReload = null;
  let btnAim = null;
  let wheel = null;
  const cells = [];
  let wheelOpen = false;
  let wheelSel = -1;
  let press = null; // { id, t0, x0, y0, cx, cy, moved, timer }
  let aimPointer = null;
  const hudApi = { aimHeld: false };
  const listeners = [];
  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };
  const prevent = (e) => {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
  };
  const capture = (e) => {
    try {
      if (e.currentTarget && e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {
      // 已結束的指標會丟例外，忽略
    }
  };
  const nowMs = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

  function setWheel(open) {
    wheelOpen = open;
    if (!wheel) return;
    wheel.hidden = !open;
    if (!open) {
      wheelSel = -1;
      for (const c of cells) toggle(c, 'wp-sel', false);
    }
  }

  function markSel(s) {
    if (s === wheelSel) return;
    wheelSel = s;
    cells.forEach((c, i) => toggle(c, 'wp-sel', i === s));
  }

  if (touch && touchRoot) {
    btnWeapon = el(doc, 'button', 'wp-tbtn wp-tb-weapon', 'tb-weapon');
    btnWeapon.type = 'button';
    btnLabel = el(doc, 'span', 'wp-tb-label');
    btnLabel.textContent = WEAPONS.fist.label;
    btnWeapon.appendChild(btnLabel);
    btnReload = el(doc, 'button', 'wp-tbtn wp-tb-reload', 'tb-reload');
    btnReload.type = 'button';
    btnReload.textContent = '裝填';
    btnAim = el(doc, 'button', 'wp-tbtn wp-tb-aim', 'tb-aim');
    btnAim.type = 'button';
    btnAim.textContent = '瞄準';
    wheel = el(doc, 'div', 'wp-wheel', 'wp-wheel');
    const off = { x: 0, y: 0 };
    SLOT_IDS.forEach((id, i) => {
      const c = el(doc, 'div', 'wp-cell');
      c.textContent = WEAPONS[id].label;
      wheelCellOffset(i, off);
      c.style.transform = `translate(${off.x.toFixed(1)}px, ${off.y.toFixed(1)}px)`;
      wheel.appendChild(c);
      cells.push(c);
    });
    wheel.hidden = true;
    btnWeapon.appendChild(wheel);
    for (const b of [btnWeapon, btnReload, btnAim]) {
      b.setAttribute('data-show', 'walk');
      touchRoot.appendChild(b);
      buttons.push(b);
    }

    on(btnWeapon, 'pointerdown', (e) => {
      prevent(e);
      // 重疊觸控（快速連點時前一指還沒放開）或前一次 press 卡住：先結算前一次，再開始新的
      if (press) settleWeapon(e, 'preempt');
      capture(e);
      const r = btnWeapon.getBoundingClientRect ? btnWeapon.getBoundingClientRect() : { left: e.clientX, top: e.clientY, width: 0, height: 0 };
      press = { id: e.pointerId, t0: nowMs(), x0: e.clientX, y0: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: 0, timer: null };
      toggle(btnWeapon, 'active', true);
      press.timer = setTimeout(() => {
        if (press) setWheel(true);
      }, LONG_PRESS_MS);
    });
    on(btnWeapon, 'pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;
      press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x0, e.clientY - press.y0));
      if (wheelOpen) markSel(wheelSlotFromVector(e.clientX - press.cx, e.clientY - press.cy));
    });
    // 結算目前 press：mode 'up' = 正常放開（短按 cycle、輪盤選格 select）；'cancel' = pointercancel / lostpointercapture
    //   （只清狀態）；'preempt' = 被下一指搶先（短按仍算一次 cycle，輪盤取消）
    function settleWeapon(e, mode) {
      clearTimeout(press.timer);
      const kind = wheelOpen ? 'long' : classifyPress(nowMs() - press.t0, press.moved);
      if (kind === 'long') {
        const s = mode === 'up' ? wheelSlotFromVector(e.clientX - press.cx, e.clientY - press.cy) : -1;
        if (s >= 0) select(s);
      } else if (kind === 'tap' && mode !== 'cancel') cycle();
      press = null;
      setWheel(false);
      toggle(btnWeapon, 'active', false);
    }
    const endWeapon = (e) => {
      if (!press || e.pointerId !== press.id) return;
      prevent(e);
      settleWeapon(e, e.type === 'pointerup' ? 'up' : 'cancel');
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(btnWeapon, type, endWeapon);
    on(btnWeapon, 'contextmenu', prevent);

    on(btnReload, 'pointerdown', (e) => {
      prevent(e);
      reload();
    });
    on(btnReload, 'contextmenu', prevent);

    on(btnAim, 'pointerdown', (e) => {
      prevent(e);
      if (aimPointer !== null) return;
      capture(e);
      aimPointer = e.pointerId;
      hudApi.aimHeld = true;
      toggle(btnAim, 'active', true);
      if (input && input.touchPress) input.touchPress('Mouse2', true);
    });
    const endAim = (e) => {
      if (aimPointer !== null && e.pointerId === aimPointer) releaseAim();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(btnAim, type, endAim);
    on(btnAim, 'contextmenu', prevent);
  }

  // ---------- 每幀 ----------
  let shownWeapon = null;
  let shownAmmo = null;
  let shownMag = -1;
  let shownRes = -1;
  let shownReload = -2;
  let shownCross = null;
  let shownAim = null;
  let shownPistolBtns = null;
  let shownKeys = null;
  let driving = false;
  let visible = true;

  function setWeapon(id) {
    shownWeapon = id;
    name.textContent = WEAPONS[id].label;
    iconFor = id;
    if (iconOk[id] === false) {
      icon.hidden = true;
      name.hidden = false;
    } else {
      icon.hidden = iconOk[id] !== true;
      name.hidden = iconOk[id] === true;
      icon.src = `${imgBase}weapon-${id}.png`;
    }
    toggle(panel, 'wp-armed', id !== 'fist');
    keyCells.forEach((k, i) => {
      const cur = SLOT_IDS[i] === id;
      toggle(k, 'wp-cur', cur);
      k.style.fontWeight = cur ? 'bold' : 'normal';
    });
    if (btnLabel) btnLabel.textContent = WEAPONS[id].label;
  }

  function update(dt, state = {}) {
    const id = weapons.current;
    if (id !== shownWeapon) setWeapon(id);
    const a = weapons.ammo();
    const pistol = id === 'pistol';
    if (pistol !== shownAmmo || (pistol && (a.mag !== shownMag || a.reserve !== shownRes))) {
      shownAmmo = pistol;
      shownMag = a.mag;
      shownRes = a.reserve;
      ammo.textContent = ammoText(id, a.mag, Number.isFinite(a.reserve) ? a.reserve : '∞'); // 無限備彈顯示 ∞
      ammo.hidden = !pistol;
      toggle(ammo, 'wp-empty', pistol && a.mag === 0);
    }
    const rp = weapons.reloadProgress ? weapons.reloadProgress() : null;
    const rq = rp === null ? -1 : Math.round(rp * 50) / 50;
    if (rq !== shownReload) {
      shownReload = rq;
      bar.hidden = rq < 0;
      fill.style.width = `${Math.max(0, rq) * 100}%`;
    }
    const drv = !!state.driving || driving;
    const showCross = pistol && !drv && visible;
    if (showCross !== shownCross) {
      shownCross = showCross;
      toggle(cross, 'wp-show', showCross);
    }
    const aimK = Number.isFinite(state.aimBlend) ? state.aimBlend : weapons.aiming ? 1 : 0;
    const aimOn = showCross && aimK > 0.5;
    if (aimOn !== shownAim) {
      shownAim = aimOn;
      toggle(cross, 'wp-aim', aimOn);
    }
    const pb = pistol && !drv;
    if (pb !== shownPistolBtns && btnReload) {
      shownPistolBtns = pb;
      btnReload.hidden = !pb;
      btnAim.hidden = !pb;
      if (!pb) releaseAim();
    }
    if (keys && drv !== shownKeys) {
      shownKeys = drv;
      keys.hidden = drv; // 駕駛中不處理武器鍵
      keys.style.display = drv ? 'none' : 'flex';
    }
    if (drv && wheelOpen) setWheel(false);
  }

  // 放開瞄準（手指離開 / 換掉手槍 / 上車 / dispose）
  function releaseAim() {
    if (aimPointer === null) return;
    aimPointer = null;
    hudApi.aimHeld = false;
    if (btnAim) toggle(btnAim, 'active', false);
    if (input && input.touchRelease) input.touchRelease('Mouse2');
  }

  function setDriving(v) {
    driving = !!v;
    toggle(panel, 'wp-driving', driving);
    if (btnWeapon) btnWeapon.hidden = driving;
  }

  function setVisible(v) {
    visible = !!v;
    panel.hidden = !visible;
    toggle(cross, 'wp-show', visible && shownCross);
    for (const b of buttons) toggle(b, 'wp-off', !visible);
  }

  function dispose() {
    if (press) clearTimeout(press.timer);
    releaseAim();
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
    listeners.length = 0;
    for (const e of [panel, cross, ...buttons]) if (e.parentNode) e.parentNode.removeChild(e);
  }

  Object.assign(hudApi, {
    update,
    setDriving,
    setVisible,
    isWheelOpen: () => wheelOpen,
    dispose,
    el: panel,
    crosshair: cross,
    buttons: { weapon: btnWeapon, reload: btnReload, aim: btnAim },
    keys,
  });
  return hudApi;
}
