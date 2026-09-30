// 程序合成基元（契約 §15）：白 / 粉噪 buffer（啟動時建一次重用）、噪聲 / 振盪器 + 濾波 + 包絡
// 所有函式都以「voice」為單位：v = { ctx, out: GainNode（該音效的輸出）, sources: [] }，
// 建立的 AudioScheduledSourceNode 一律推進 v.sources，讓音源池可以整批 stop()
// 不下載任何音檔；node 無頭測試以假 AudioContext 驗證（tools/test/audio.mjs）

const SILENT = 0.0001; // exponentialRamp 不能到 0

// 噪聲 buffer：white 1 s、pink 2 s（Paul Kellet 濾波近似），單聲道；只在解鎖時建一次
export function makeNoiseBuffers(ctx, rng = Math.random) {
  const sr = ctx.sampleRate || 44100;
  const white = ctx.createBuffer(1, Math.floor(sr * 1), sr);
  const wd = white.getChannelData(0);
  for (let i = 0; i < wd.length; i++) wd[i] = rng() * 2 - 1;
  const pink = ctx.createBuffer(1, Math.floor(sr * 2), sr);
  const pd = pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < pd.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return { white, pink };
}

// 起音 a 秒到 peak，再以指數衰減 d 秒到近乎無聲
export function envelope(param, t, peak, a, d) {
  param.setValueAtTime(SILENT, t);
  param.linearRampToValueAtTime(Math.max(SILENT, peak), t + Math.max(0.001, a));
  param.exponentialRampToValueAtTime(SILENT, t + Math.max(0.001, a) + Math.max(0.005, d));
}

// 起音後維持 hold 秒再放開 r 秒（喇叭用）
export function envelopeHold(param, t, peak, a, hold, r) {
  param.setValueAtTime(SILENT, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setValueAtTime(peak, t + a + hold);
  param.exponentialRampToValueAtTime(SILENT, t + a + hold + r);
}

// 噪聲爆音：buffer → 濾波 → 包絡 → dest（預設 v.out）；回傳總長（秒）
// o = { buf, type, freq, freqEnd, Q, gain, a, d, dest }
export function noiseHit(v, t, o) {
  const ctx = v.ctx;
  const src = ctx.createBufferSource();
  src.buffer = o.buf;
  const f = ctx.createBiquadFilter();
  f.type = o.type || 'lowpass';
  f.frequency.setValueAtTime(o.freq || 1000, t);
  if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + (o.a || 0.001) + (o.d || 0.1));
  f.Q.value = o.Q || 0.7;
  const g = ctx.createGain();
  const a = o.a || 0.001;
  const d = o.d || 0.1;
  envelope(g.gain, t, o.gain == null ? 1 : o.gain, a, d);
  src.connect(f);
  f.connect(g);
  g.connect(o.dest || v.out);
  const len = o.buf && o.buf.duration ? o.buf.duration : 1;
  const dur = a + d + 0.02;
  // 從 buffer 隨機位置開始，同一段噪聲每次聽起來不同
  src.start(t, Math.random() * Math.max(0, len - dur - 0.01), dur);
  v.sources.push(src);
  return dur;
}

// 振盪器音：osc（可滑音）→ 包絡 → dest；回傳總長（秒）
// o = { type, freq, freqEnd, gain, a, d, dest }
export function toneHit(v, t, o) {
  const ctx = v.ctx;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  const a = o.a || 0.002;
  const d = o.d || 0.1;
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + a + d);
  const g = ctx.createGain();
  envelope(g.gain, t, o.gain == null ? 0.5 : o.gain, a, d);
  osc.connect(g);
  g.connect(o.dest || v.out);
  const dur = a + d + 0.02;
  osc.start(t);
  osc.stop(t + dur);
  v.sources.push(osc);
  return dur;
}

// 迴圈噪聲源（持續音源用）：buffer loop → 濾波；回傳 { src, filter }，由呼叫端接到自己的增益
export function noiseLoop(v, buf, type, freq, Q) {
  const ctx = v.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  src.connect(f);
  v.sources.push(src);
  return { src, filter: f };
}
