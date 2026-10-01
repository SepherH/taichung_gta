// 車上電台（程序生成音樂）：WebAudio 振盪器 / 噪聲即時合成，不下載任何音檔、不使用任何錄音或取樣
// 所有旋律、和聲進行、節奏型皆為本檔自行編寫（STATIONS 的 source 欄位註明「自製」）；不含任何既有曲目或其改編
//
// 對外 API（給整合單元）：
//   createRadio({ getAudio, getMusicVolume, stations = STATIONS }) →
//     { update(dt, { inVehicle, paused }), next(), setStation(i | null), getState(), stats(), dispose() }
//   - getAudio() → { ctx: AudioContext, out?: AudioNode } | null
//       未解鎖回 null（或 ctx.state 非 'running'）→ 本模組不建立任何節點、不排程；解鎖後下一次 update 才開始
//       out 省略 = ctx.destination；建議接 audio 的 master 增益（已含主音量），本模組自己再乘音樂音量
//   - getMusicVolume() → 0..1（例：() => settings.get('volumeMusic')）；每次 update 讀取，變動時平滑跟隨
//   - update(dt, { inVehicle, paused })：每幀呼叫；inVehicle 且已選台且未暫停才播，否則淡出並停止所有節點
//   - next()：第 1 台 → 第 2 台 → … → 最後一台 → 關閉 → 第 1 台（循環）
//   - setStation(i | null)：直接選台（null = 關閉；非法索引忽略）
//   - getState() → { on, playing, index, name, stations: [台名…] }
//       on = 已選台（非關閉）；playing = 目前實際在出聲；index = 選中台索引（關閉為 null）；name 關閉時為「關閉」
//       下車不會清掉選台：再上車恢復上次的台（初始為第 1 台）
//   - dispose()：立即停止並斷開所有節點，之後一切呼叫為 no-op
// 排程：lookahead scheduling——每次 update 把 [now, now + LOOKAHEAD) 內的音符排到 AudioContext 時間軸上；
//   幀卡頓導致落後時直接跳到現在（不補播一串）；切台交叉淡變（FADE_OUT / FADE_IN），淡出結束後 stop + disconnect，不留殘餘節點

export const LOOKAHEAD = 0.3; // s：每次 update 往前排程的時間窗
export const FADE_IN = 0.8; // s
export const FADE_OUT = 0.6; // s
const SILENT = 0.0001;
const OFF_NAME = '關閉';

// ---------------------------------------------------------------------------
// 曲譜（全部自製）
// 音符字串：音名（C4、F#3、Bb4）= 起音；'-' = 延長前一個音；'.' = 休止；'|' 只是小節分隔（忽略）
// 鼓字串：'x' = 重、'o' = 輕、'.' = 無
// chords：每 chordSteps 步換一個和弦（MIDI 音高陣列），配合 pattern（'x' 起音、'-' 延長）
// arp：依和弦音循環 order（和弦音索引，超出取高八度）
// ---------------------------------------------------------------------------
const C = {
  Fmaj7: [53, 57, 60, 64], Em7: [52, 55, 59, 62], Dm7: [50, 53, 57, 60], Cmaj7: [48, 52, 55, 59],
  Am: [57, 60, 64], F: [53, 57, 60], Cq: [55, 60, 64], G: [55, 59, 62],
  Am3: [57, 60, 64], Dm: [57, 62, 65], E: [56, 59, 64], Fv: [57, 60, 65], Gv: [55, 59, 62],
};

export const STATIONS = [
  {
    id: 'lofi',
    name: '大墩夜風 FM 88.3',
    genre: 'lo-fi',
    source: '自製（Fmaj7–Em7–Dm7–Cmaj7 進行，旋律自行編寫）',
    bpm: 76,
    stepsPerBeat: 2,
    swing: 0.14,
    filter: 1700,
    level: 0.85,
    tracks: [
      { type: 'notes', inst: 'epiano', gain: 0.22, notes: 'A4 - C5 E5 - - D5 C5 | B4 - - G4 A4 B4 D5 - | C5 - A4 - F4 A4 C5 D5 | E5 - - D5 B4 - G4 .' },
      { type: 'notes', inst: 'bass', gain: 0.32, notes: 'F2 - - . C3 - . . | E2 - - . B2 - . . | D2 - - . A2 - . . | C2 - - . G2 - E2 .' },
      { type: 'chords', inst: 'pad', gain: 0.07, chordSteps: 8, chords: [C.Fmaj7, C.Em7, C.Dm7, C.Cmaj7], pattern: 'x - - - - - - -' },
      { type: 'drum', inst: 'kick', gain: 0.5, hits: 'x . . . . . . . | x . . x . . . .' },
      { type: 'drum', inst: 'snare', gain: 0.18, hits: '. . x . . . x .' },
      { type: 'drum', inst: 'hat', gain: 0.06, hits: 'o o o o o o o o' },
    ],
  },
  {
    id: 'electro',
    name: '七期霓虹 FM 101.7',
    genre: '電子',
    source: '自製（Am–F–C–G 進行，琶音與低音由程式依和弦產生）',
    bpm: 122,
    stepsPerBeat: 4,
    swing: 0,
    filter: 4200,
    level: 0.75,
    tracks: [
      { type: 'arp', inst: 'pluck', gain: 0.13, chordSteps: 16, chords: [C.Am, C.F, C.Cq, C.G], order: [0, 1, 2, 3, 2, 1, 0, 2, 0, 1, 2, 3, 4, 3, 2, 1], octave: 12 },
      { type: 'notes', inst: 'bass', gain: 0.3, notes: '. . A2 . . . A2 . . . A2 . . . A2 . | . . F2 . . . F2 . . . F2 . . . F2 . | . . C2 . . . C2 . . . C2 . . . C2 . | . . G2 . . . G2 . . . G2 . . . B2 .' },
      { type: 'notes', inst: 'lead', gain: 0.1, notes: 'E5 - - - . . C5 - D5 - E5 - . . . . | C5 - - - . . A4 - C5 - D5 - . . . . | E5 - - - G5 - - - E5 - D5 - C5 - . . | B4 - - - D5 - - - . . . . . . . .' },
      { type: 'drum', inst: 'kick', gain: 0.6, hits: 'x . . . x . . . x . . . x . . .' },
      { type: 'drum', inst: 'clap', gain: 0.2, hits: '. . . . x . . . . . . . x . . .' },
      { type: 'drum', inst: 'hat', gain: 0.08, hits: '. . x . . . x . . . x . . . x o' },
    ],
  },
  {
    id: 'retro',
    name: '柳川懷舊 AM 1188',
    genre: '台式復古小調',
    source: '自製（A 小調、五聲音階為主的旋律自行編寫，和聲 Am–Dm–E–Am / F–G–E–Am）',
    bpm: 92,
    stepsPerBeat: 2,
    swing: 0,
    filter: 2600,
    level: 0.85,
    tracks: [
      {
        type: 'notes',
        inst: 'retroLead',
        gain: 0.16,
        notes:
          'E5 - D5 C5 A4 - C5 D5 | F5 - E5 D5 E5 - - . | D5 C5 B4 - G#4 - B4 . | A4 - - - . . C5 D5 | ' +
          'E5 - G5 E5 D5 - C5 . | D5 - E5 D5 B4 - G4 . | A4 C5 B4 A4 G#4 - B4 . | A4 - - - - - . .',
      },
      { type: 'notes', inst: 'bass', gain: 0.3, notes: 'A2 . E2 . A2 . E2 . | D2 . A2 . D2 . A2 . | E2 . B2 . E2 . B2 . | A2 . E2 . A2 . E2 . | F2 . C3 . F2 . C3 . | G2 . D3 . G2 . D3 . | E2 . B2 . E2 . B2 . | A2 . E2 . A2 - - .' },
      { type: 'chords', inst: 'organ', gain: 0.06, chordSteps: 8, chords: [C.Am3, C.Dm, C.E, C.Am3, C.Fv, C.Gv, C.E, C.Am3], pattern: '. x . x . x . x' },
      { type: 'drum', inst: 'kick', gain: 0.35, hits: 'x . . . x . . .' },
      { type: 'drum', inst: 'snare', gain: 0.1, hits: '. . o . . . o .' },
    ],
  },
];

// ---------------------------------------------------------------------------
// 曲譜編譯
// ---------------------------------------------------------------------------
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToMidi(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) return null;
  return NOTE_BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const tokens = (s) => s.split(/\s+/).filter((t) => t && t !== '|');

// 回傳每步的事件陣列：null 或 { midis: [...], dur: 步數 }
function compileNotes(str) {
  const tk = tokens(str);
  const out = new Array(tk.length).fill(null);
  let last = -1;
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (t === '-') {
      if (last >= 0) out[last].dur++;
    } else if (t === '.') {
      last = -1;
    } else {
      const m = noteToMidi(t);
      if (m === null) throw new Error(`[radio] 無法解析音名：${t}`);
      out[i] = { midis: [m], dur: 1 };
      last = i;
    }
  }
  return out;
}

function compileTrack(tr) {
  if (tr.type === 'notes') return { ...tr, steps: compileNotes(tr.notes) };
  if (tr.type === 'drum') {
    const steps = tokens(tr.hits).map((t) => (t === 'x' ? { vel: 1 } : t === 'o' ? { vel: 0.55 } : null));
    return { ...tr, steps };
  }
  if (tr.type === 'chords') {
    const pat = compileNotes(tokens(tr.pattern).map((t) => (t === 'x' ? 'C4' : t)).join(' '));
    const n = tr.chordSteps * tr.chords.length;
    const steps = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const p = pat[i % pat.length];
      if (p) steps[i] = { midis: tr.chords[Math.floor(i / tr.chordSteps)], dur: p.dur };
    }
    return { ...tr, steps };
  }
  if (tr.type === 'arp') {
    const n = tr.chordSteps * tr.chords.length;
    const steps = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const ch = tr.chords[Math.floor(i / tr.chordSteps)];
      const k = tr.order[i % tr.order.length];
      const midi = ch[k % ch.length] + 12 * Math.floor(k / ch.length) + (tr.octave || 0);
      steps[i] = { midis: [midi], dur: 1 };
    }
    return { ...tr, steps };
  }
  throw new Error(`[radio] 未知軌道類型：${tr.type}`);
}

function compileStation(st) {
  const tracks = st.tracks.map(compileTrack);
  return { ...st, tracks, stepDur: 60 / st.bpm / st.stepsPerBeat };
}

// ---------------------------------------------------------------------------
// 樂器（每個音建立自己的 osc / gain，推進 p.sources 讓整批可停）
// ---------------------------------------------------------------------------
function env(param, t, peak, a, hold, rel) {
  param.setValueAtTime(SILENT, t);
  param.linearRampToValueAtTime(Math.max(SILENT, peak), t + a);
  param.exponentialRampToValueAtTime(Math.max(SILENT, peak * 0.35), t + a + Math.max(0.01, hold));
  param.exponentialRampToValueAtTime(SILENT, t + a + Math.max(0.01, hold) + rel);
  return a + Math.max(0.01, hold) + rel;
}

function osc(p, type, hz, t, end, dest) {
  const o = p.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, t);
  o.connect(dest);
  o.start(t);
  o.stop(end);
  p.sources.push({ node: o, end });
  return o;
}

function noteGain(p, t, peak, a, hold, rel) {
  const g = p.ctx.createGain();
  const len = env(g.gain, t, peak, a, hold, rel);
  g.connect(p.bus);
  p.nodes.push({ node: g, end: t + len + 0.05 });
  return { g, end: t + len + 0.02 };
}

const INSTRUMENTS = {
  epiano(p, hz, t, d, v) {
    const { g, end } = noteGain(p, t, v, 0.01, d * 0.9, 0.5);
    osc(p, 'triangle', hz, t, end, g);
    const g2 = p.ctx.createGain();
    g2.gain.value = 0.25;
    g2.connect(g);
    p.nodes.push({ node: g2, end: end + 0.05 });
    osc(p, 'sine', hz * 2, t, end, g2);
  },
  bass(p, hz, t, d, v) {
    const { g, end } = noteGain(p, t, v, 0.01, d * 0.85, 0.12);
    osc(p, 'sine', hz, t, end, g);
    osc(p, 'triangle', hz, t, end, g);
  },
  pad(p, hz, t, d, v) {
    const { g, end } = noteGain(p, t, v, 0.25, d, 0.6);
    osc(p, 'triangle', hz, t, end, g);
    osc(p, 'sine', hz * 1.003, t, end, g);
  },
  organ(p, hz, t, d, v) {
    const { g, end } = noteGain(p, t, v, 0.01, d * 0.6, 0.08);
    osc(p, 'square', hz, t, end, g);
  },
  pluck(p, hz, t, d, v) {
    const { g, end } = noteGain(p, t, v, 0.003, 0.08, 0.12);
    osc(p, 'sawtooth', hz, t, end, g);
  },
  lead(p, hz, t, d, v) {
    const { g, end } = noteGain(p, t, v, 0.02, d * 0.9, 0.15);
    osc(p, 'square', hz, t, end, g);
    osc(p, 'sawtooth', hz * 1.005, t, end, g);
  },
  retroLead(p, hz, t, d, v) {
    // 復古味：方波 + 輕顫音（LFO 調 frequency）
    const { g, end } = noteGain(p, t, v, 0.02, d * 0.95, 0.18);
    const o = osc(p, 'square', hz, t, end, g);
    const lfoAmt = p.ctx.createGain();
    lfoAmt.gain.value = hz * 0.006;
    lfoAmt.connect(o.frequency);
    p.nodes.push({ node: lfoAmt, end: end + 0.05 });
    osc(p, 'sine', 5.5, t + Math.min(0.15, d * 0.4), end, lfoAmt);
  },
  kick(p, _hz, t, _d, v) {
    const { g, end } = noteGain(p, t, v, 0.002, 0.08, 0.12);
    const o = osc(p, 'sine', 120, t, end, g);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  },
  snare(p, _hz, t, _d, v) {
    noise(p, t, v, 'bandpass', 1800, 0.12);
  },
  clap(p, _hz, t, _d, v) {
    noise(p, t, v, 'bandpass', 1200, 0.1);
  },
  hat(p, _hz, t, _d, v) {
    noise(p, t, v, 'highpass', 7000, 0.04);
  },
};

function noise(p, t, v, type, freq, d) {
  const { g, end } = noteGain(p, t, v, 0.002, d * 0.5, d);
  const f = p.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.connect(g);
  p.nodes.push({ node: f, end: end + 0.05 });
  const src = p.ctx.createBufferSource();
  src.buffer = p.noiseBuf;
  src.connect(f);
  src.start(t);
  src.stop(end);
  p.sources.push({ node: src, end });
}

// 白噪 buffer（固定亂數種子，每個 AudioContext 建一次）
function makeNoise(ctx) {
  const sr = ctx.sampleRate || 44100;
  const buf = ctx.createBuffer(1, Math.floor(sr * 0.5), sr);
  const d = buf.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 電台
// ---------------------------------------------------------------------------
function safe(fn) {
  try {
    fn();
  } catch (err) {
    // 節點已停止 / 已斷開：忽略
  }
}

export function createRadio({ getAudio, getMusicVolume, stations = STATIONS } = {}) {
  const compiled = stations.map(compileStation);
  const names = compiled.map((s) => s.name);

  let selected = compiled.length > 0 ? 0 : null; // 選中台（null = 關閉）；下車不清，上車恢復
  let disposed = false;
  let ctx = null;
  let out = null; // 本模組的音樂音量增益（接到注入的輸出節點）
  let noiseBuf = null;
  let vol = -1;
  let current = null; // 正在播（或淡入中）的 player
  const dying = []; // 淡出中的 player

  function readVolume() {
    let v = 0;
    try {
      v = typeof getMusicVolume === 'function' ? Number(getMusicVolume()) : 1;
    } catch (err) {
      v = 0;
    }
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }

  // 取得已解鎖且在跑的 context；未解鎖回 null（不建任何節點）
  function readyAudio() {
    let a = null;
    try {
      a = typeof getAudio === 'function' ? getAudio() : null;
    } catch (err) {
      a = null;
    }
    if (!a || !a.ctx) return null;
    if (a.ctx.state !== undefined && a.ctx.state !== 'running') return null;
    return a;
  }

  function killPlayer(p, now) {
    for (const s of p.sources) safe(() => s.node.stop(now));
    for (const s of p.sources) safe(() => s.node.disconnect());
    for (const n of p.nodes) safe(() => n.node.disconnect());
    p.sources.length = 0;
    p.nodes.length = 0;
    safe(() => p.bus.disconnect());
    safe(() => p.fade.disconnect());
  }

  // context 換了（或第一次）→ 舊節點全部丟掉、重建音量增益
  function bindContext(a) {
    if (ctx === a.ctx) return;
    if (ctx) {
      const now = ctx.currentTime;
      if (current) killPlayer(current, now);
      for (const p of dying) killPlayer(p, now);
      safe(() => out.disconnect());
    }
    current = null;
    dying.length = 0;
    ctx = a.ctx;
    noiseBuf = makeNoise(ctx);
    out = ctx.createGain();
    vol = readVolume();
    out.gain.value = vol;
    out.connect(a.out || ctx.destination);
  }

  function startPlayer(index, now) {
    const st = compiled[index];
    const fade = ctx.createGain();
    fade.gain.setValueAtTime(SILENT, now);
    fade.gain.linearRampToValueAtTime(st.level, now + FADE_IN);
    fade.connect(out);
    const bus = ctx.createBiquadFilter();
    bus.type = 'lowpass';
    bus.frequency.value = st.filter;
    bus.Q.value = 0.5;
    bus.connect(fade);
    return { index, st, ctx, noiseBuf, fade, bus, sources: [], nodes: [], step: 0, nextTime: now + 0.05, stopAt: null };
  }

  function fadeOut(p, now) {
    if (p.stopAt !== null) return;
    p.stopAt = now + FADE_OUT;
    const g = p.fade.gain;
    if (typeof g.cancelScheduledValues === 'function') g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(SILENT, g.value || p.st.level), now);
    g.linearRampToValueAtTime(SILENT, p.stopAt);
    // 所有已排程音源最晚在淡出結束時停（起音在之後的音符因此不會出聲）
    for (const s of p.sources) {
      if (s.end > p.stopAt) {
        s.end = p.stopAt;
        safe(() => s.node.stop(p.stopAt));
      }
    }
    dying.push(p);
  }

  function schedule(p, now) {
    // 落後（幀卡頓 / 分頁回前景）：跳到現在，不補播
    if (p.nextTime < now) p.nextTime = now + 0.02;
    const st = p.st;
    const horizon = now + LOOKAHEAD;
    while (p.nextTime < horizon) {
      const step = p.step;
      let t = p.nextTime;
      if (st.swing && step % 2 === 1) t += st.swing * st.stepDur;
      for (const tr of st.tracks) {
        const ev = tr.steps[step % tr.steps.length];
        if (!ev) continue;
        const inst = INSTRUMENTS[tr.inst];
        if (tr.type === 'drum') inst(p, 0, t, st.stepDur, tr.gain * ev.vel);
        else for (const m of ev.midis) inst(p, midiToHz(m), t, ev.dur * st.stepDur, tr.gain / Math.sqrt(ev.midis.length));
      }
      p.step++;
      p.nextTime += st.stepDur;
    }
  }

  // 已結束的音源 / 節點斷開（原地壓縮）
  function reap(p, now) {
    let w = 0;
    for (let i = 0; i < p.sources.length; i++) {
      const s = p.sources[i];
      if (s.end + 0.05 < now) safe(() => s.node.disconnect());
      else p.sources[w++] = s;
    }
    p.sources.length = w;
    w = 0;
    for (let i = 0; i < p.nodes.length; i++) {
      const n = p.nodes[i];
      if (n.end < now) safe(() => n.node.disconnect());
      else p.nodes[w++] = n;
    }
    p.nodes.length = w;
  }

  function update(dt, state) {
    if (disposed) return;
    const a = readyAudio();
    if (!a) return; // 未解鎖 / context 暫停：不建節點、不排程
    bindContext(a);
    const now = ctx.currentTime;
    const want = !!(state && state.inVehicle) && !(state && state.paused) && selected !== null ? selected : null;

    if (current && current.index !== want) {
      fadeOut(current, now);
      current = null;
    }
    if (!current && want !== null) current = startPlayer(want, now);

    const v = readVolume();
    if (Math.abs(v - vol) > 0.001) {
      vol = v;
      out.gain.setTargetAtTime(v, now, 0.05);
    }

    if (current) {
      schedule(current, now);
      reap(current, now);
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const p = dying[i];
      if (now >= p.stopAt + 0.05) {
        killPlayer(p, now);
        dying.splice(i, 1);
      } else {
        reap(p, now);
      }
    }
  }

  function setStation(i) {
    if (disposed) return;
    if (i === null) selected = null;
    else if (Number.isInteger(i) && i >= 0 && i < compiled.length) selected = i;
  }

  function next() {
    if (disposed || compiled.length === 0) return;
    if (selected === null) selected = 0;
    else selected = selected + 1 < compiled.length ? selected + 1 : null;
  }

  function getState() {
    return {
      on: selected !== null,
      playing: !!current,
      index: selected,
      name: selected === null ? OFF_NAME : names[selected],
      stations: names.slice(),
    };
  }

  // 除錯 / 測試：活著的 player 數、未結束音源數、輔助節點數
  function stats() {
    const all = current ? [current, ...dying] : dying;
    let sources = 0;
    let nodes = 0;
    for (const p of all) {
      sources += p.sources.length;
      nodes += p.nodes.length;
    }
    return { players: all.length, fading: dying.length, sources, nodes, bound: !!ctx };
  }

  function dispose() {
    if (disposed) return;
    if (ctx) {
      const now = ctx.currentTime;
      if (current) killPlayer(current, now);
      for (const p of dying) killPlayer(p, now);
      safe(() => out.disconnect());
    }
    current = null;
    dying.length = 0;
    ctx = null;
    out = null;
    disposed = true;
  }

  return { update, next, setStation, getState, stats, dispose };
}
