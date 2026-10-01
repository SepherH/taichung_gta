// 音效配方（契約 §15）：一次性音效 RECIPES[name](v, t, o, nb) → 長度（秒）；持續音源 LOOPS[name](v, nb) → 控制器
// v = { ctx, out, sources }（見 synth.js）；nb = { white, pink } 噪聲 buffer；o = play() 的 opts
// 全部以噪聲 + 振盪器 + 濾波 + 包絡合成，不讀任何音檔

import { noiseHit, toneHit, noiseLoop, envelopeHold } from './synth.js';

// ±k 的隨機音高變化，避免重複音效聽起來一模一樣
const vary = (k) => 1 + (Math.random() * 2 - 1) * k;

// 金屬喀噠一聲（裝填 / 空槍共用）
function click(v, t, nb, freq, gain) {
  noiseHit(v, t, { buf: nb.white, type: 'bandpass', freq, Q: 6, gain, a: 0.001, d: 0.035 });
  toneHit(v, t, { type: 'triangle', freq: freq * 0.45, freqEnd: freq * 0.3, gain: gain * 0.35, a: 0.001, d: 0.03 });
}

function arpeggio(v, t, notes, step, type, gain, d) {
  let end = 0;
  for (let i = 0; i < notes.length; i++) {
    end = i * step + toneHit(v, t + i * step, { type, freq: notes[i], gain, a: 0.005, d });
  }
  return end;
}

export const RECIPES = {
  // 槍聲：短噪爆 + 低頻 thump + 尾音
  gunshot(v, t, o, nb) {
    const p = vary(0.05);
    noiseHit(v, t, { buf: nb.white, type: 'highpass', freq: 900 * p, gain: 1, a: 0.001, d: 0.09 });
    toneHit(v, t, { type: 'sine', freq: 140 * p, freqEnd: 42, gain: 0.9, a: 0.001, d: 0.2 });
    noiseHit(v, t + 0.01, { buf: nb.pink, type: 'lowpass', freq: 2200 * p, freqEnd: 400, gain: 0.45, a: 0.005, d: 0.45 });
    return 0.5;
  },
  // 空槍：單一乾硬喀
  dryfire(v, t, o, nb) {
    click(v, t, nb, 3400 * vary(0.05), 0.45);
    return 0.08;
  },
  // 裝填：金屬喀噠兩聲（start = 退彈匣 + 插彈匣；end = 拉滑套兩聲、較亮）
  reload(v, t, o, nb) {
    if (o && o.phase === 'end') {
      click(v, t, nb, 2200, 0.45);
      click(v, t + 0.09, nb, 3300, 0.5);
    } else {
      click(v, t, nb, 2600, 0.4);
      click(v, t + 0.16, nb, 1900, 0.5);
    }
    return 0.28;
  },
  // 子彈打到非角色（weapon:impact）：world 石面「啾」/ vehicle 金屬「鏘」
  ricochet(v, t, o, nb) {
    const p = vary(0.08);
    if (o && o.surface === 'vehicle') {
      // 金屬：窄帶通噪聲敲擊 + 兩個非諧和三角波共鳴
      noiseHit(v, t, { buf: nb.white, type: 'bandpass', freq: 3200 * p, Q: 8, gain: 0.55, a: 0.001, d: 0.05 });
      toneHit(v, t, { type: 'triangle', freq: 1850 * p, gain: 0.3, a: 0.001, d: 0.22 });
      toneHit(v, t, { type: 'triangle', freq: 2730 * p, gain: 0.18, a: 0.001, d: 0.16 });
      return 0.25;
    }
    // 石面：高通碎裂噪聲 + 由高往低滑的跳彈「啾」
    noiseHit(v, t, { buf: nb.white, type: 'highpass', freq: 2400 * p, gain: 0.5, a: 0.001, d: 0.04 });
    toneHit(v, t + 0.01, { type: 'sine', freq: 3400 * p, freqEnd: 1300 * p, gain: 0.16, a: 0.004, d: 0.14 });
    return 0.17;
  },
  // 棒擊：木質 knock + 噪
  bat_hit(v, t, o, nb) {
    const p = vary(0.06);
    toneHit(v, t, { type: 'triangle', freq: 240 * p, freqEnd: 150 * p, gain: 0.7, a: 0.001, d: 0.12 });
    toneHit(v, t, { type: 'sine', freq: 560 * p, gain: 0.25, a: 0.001, d: 0.05 });
    noiseHit(v, t, { buf: nb.white, type: 'bandpass', freq: 1200, Q: 1.5, gain: 0.5, a: 0.001, d: 0.08 });
    return 0.25;
  },
  // 揮棒 / 揮拳風聲：帶通噪聲掃頻（拳較短較輕）
  bat_swing(v, t, o, nb) {
    const fist = o && o.weapon === 'fist';
    const d = fist ? 0.12 : 0.22;
    noiseHit(v, t, {
      buf: nb.pink, type: 'bandpass', freq: (fist ? 700 : 450) * vary(0.1), freqEnd: fist ? 1600 : 1300,
      Q: 1.2, gain: fist ? 0.22 : 0.4, a: fist ? 0.04 : 0.08, d,
    });
    return d + 0.1;
  },
  // 拳擊：悶擊
  punch(v, t, o, nb) {
    const p = vary(0.08);
    toneHit(v, t, { type: 'sine', freq: 95 * p, freqEnd: 50, gain: 0.8, a: 0.001, d: 0.12 });
    noiseHit(v, t, { buf: nb.pink, type: 'lowpass', freq: 900 * p, gain: 0.55, a: 0.001, d: 0.07 });
    return 0.2;
  },
  // 腳步：低通噪 + 微弱低頻（跑步較響較亮）
  footstep(v, t, o, nb) {
    const run = !!(o && o.run);
    noiseHit(v, t, { buf: nb.pink, type: 'lowpass', freq: (run ? 900 : 600) * vary(0.15), gain: run ? 0.4 : 0.22, a: 0.002, d: 0.06 });
    toneHit(v, t, { type: 'sine', freq: 70 * vary(0.1), gain: run ? 0.2 : 0.1, a: 0.002, d: 0.04 });
    return 0.1;
  },
  // 碰撞：低頻撞擊 + 金屬 / 玻璃高頻；o.k = 0–1 力道
  crash(v, t, o, nb) {
    const k = o && Number.isFinite(o.k) ? o.k : 1;
    noiseHit(v, t, { buf: nb.white, type: 'lowpass', freq: 1800, freqEnd: 300, gain: 0.9 * k, a: 0.002, d: 0.5 });
    toneHit(v, t, { type: 'sine', freq: 65, freqEnd: 32, gain: 0.9 * k, a: 0.002, d: 0.35 });
    noiseHit(v, t + 0.02, { buf: nb.white, type: 'highpass', freq: 3200, gain: 0.35 * k, a: 0.002, d: 0.3 });
    return 0.8;
  },
  // 喇叭：兩個方波和弦 → 低通 → 維持包絡
  horn(v, t, o) {
    const ctx = v.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2200;
    const g = ctx.createGain();
    const hold = o && Number.isFinite(o.hold) ? o.hold : 0.38;
    envelopeHold(g.gain, t, 0.22, 0.01, hold, 0.06);
    f.connect(g);
    g.connect(v.out);
    const end = t + 0.01 + hold + 0.08;
    for (const hz of [392, 494]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = hz;
      osc.connect(f);
      osc.start(t);
      osc.stop(end);
      v.sources.push(osc);
    }
    return end - t;
  },
  ui_click(v, t) {
    return toneHit(v, t, { type: 'square', freq: 1400, gain: 0.12, a: 0.001, d: 0.03 });
  },
  ui_confirm(v, t) {
    return arpeggio(v, t, [660, 990], 0.07, 'triangle', 0.28, 0.12);
  },
  ui_cancel(v, t) {
    return arpeggio(v, t, [520, 390], 0.07, 'triangle', 0.26, 0.12);
  },
  ui_reward(v, t) {
    return arpeggio(v, t, [523, 659, 784, 1047], 0.075, 'triangle', 0.26, 0.2);
  },
  ui_fail(v, t) {
    return arpeggio(v, t, [392, 311, 262], 0.12, 'triangle', 0.28, 0.25);
  },
  ui_open(v, t) {
    return toneHit(v, t, { type: 'sine', freq: 420, freqEnd: 840, gain: 0.22, a: 0.01, d: 0.12 });
  },
  ui_close(v, t) {
    return toneHit(v, t, { type: 'sine', freq: 840, freqEnd: 420, gain: 0.22, a: 0.01, d: 0.12 });
  },
};

export const UI_KINDS = ['click', 'confirm', 'cancel', 'reward', 'fail', 'open', 'close'];

// 持續音源：回傳控制器 { gain: GainNode（接到呼叫端的群組）, set(state, now) }，
// 音量由呼叫端以 gain 控制；set 只調整音色參數（每幀呼叫、不配置物件、數值沒變不排程）
export const LOOPS = {
  // 引擎：鋸齒 + 次八度方波 → 低通；rpm01 → 頻率、throttle → 截止頻率（機車較高）
  engine(v) {
    const ctx = v.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    const sub = ctx.createOscillator();
    sub.type = 'square';
    const subG = ctx.createGain();
    subG.gain.value = 0.35;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    saw.connect(lp);
    sub.connect(subG);
    subG.connect(lp);
    lp.connect(gain);
    saw.start();
    sub.start();
    v.sources.push(saw, sub);
    let lastF = -1;
    let lastC = -1;
    return {
      gain,
      set(s, now) {
        const bike = !!s.twoWheeler;
        const r = clamp01(s.rpm01);
        const f = bike ? 70 + r * 250 : 42 + r * 150;
        const c = (bike ? 900 : 600) + clamp01(Math.abs(s.throttle || 0)) * (bike ? 1800 : 1200) + r * 600;
        if (Math.abs(f - lastF) > 0.5) {
          lastF = f;
          saw.frequency.setTargetAtTime(f, now, 0.05);
          sub.frequency.setTargetAtTime(f * 0.5, now, 0.05);
        }
        if (Math.abs(c - lastC) > 20) {
          lastC = c;
          lp.frequency.setTargetAtTime(c, now, 0.08);
        }
      },
    };
  },
  // 輪胎：白噪帶通；skid01 → 中心頻率
  tire(v, nb) {
    const n = noiseLoop(v, nb.white, 'bandpass', 900, 3);
    const gain = v.ctx.createGain();
    gain.gain.value = 0;
    n.filter.connect(gain);
    n.src.start();
    let last = -1;
    return {
      gain,
      set(s, now) {
        const f = 700 + clamp01(s.skid01) * 700;
        if (Math.abs(f - last) > 15) {
          last = f;
          n.filter.frequency.setTargetAtTime(f, now, 0.05);
        }
      },
    };
  },
  // 路口聲景：車流隆隆（粉噪低通）+ 低音量人聲感（粉噪帶通 × 0.25 Hz LFO 起伏）
  ambience(v, nb) {
    const ctx = v.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const rumble = noiseLoop(v, nb.pink, 'lowpass', 420, 0.7);
    rumble.filter.connect(gain);
    const murmur = noiseLoop(v, nb.pink, 'bandpass', 900, 0.9);
    const mg = ctx.createGain();
    mg.gain.value = 0.35;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.25;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.25;
    lfo.connect(lfoG);
    lfoG.connect(mg.gain);
    murmur.filter.connect(mg);
    mg.connect(gain);
    rumble.src.start(0, Math.random());
    murmur.src.start(0, Math.random());
    lfo.start();
    v.sources.push(lfo);
    return { gain, set() {} };
  },
  // 雨聲（p5-s1）：粉噪高通（雨幕沙沙）+ 白噪帶通（近處水花嘶聲）；內部 level 增益隨 s.rain（0–1）→ rainLevel，
  // 雨勢大時高通截止往下、聲音較厚；外層 gain 仍由呼叫端控制（sfx 群組、paused 靜音），s.rain 為 0 時本身就靜音
  rain(v, nb) {
    const ctx = v.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const level = ctx.createGain();
    level.gain.value = 0;
    level.connect(gain);
    const wash = noiseLoop(v, nb.pink, 'highpass', 500, 0.5);
    wash.filter.connect(level);
    const hiss = noiseLoop(v, nb.white, 'bandpass', 4200, 0.8);
    const hg = ctx.createGain();
    hg.gain.value = 0.25;
    hiss.filter.connect(hg);
    hg.connect(level);
    wash.src.start(0, Math.random());
    hiss.src.start(0, Math.random());
    let lastL = -1;
    let lastF = -1;
    return {
      gain,
      level,
      set(s, now) {
        const r = clamp01(s && s.rain);
        const l = rainLevel(r);
        if (Math.abs(l - lastL) > 0.003) {
          lastL = l;
          level.gain.setTargetAtTime(l, now, 0.4);
        }
        const f = 700 - r * 400;
        if (Math.abs(f - lastF) > 10) {
          lastF = f;
          wash.filter.frequency.setTargetAtTime(f, now, 0.4);
        }
      },
    };
  },
};

// 雨勢 0–1 → 雨聲音量（0 → 0；單調遞增，小雨即可聽見）
export function rainLevel(rain01) {
  const r = clamp01(rain01);
  return r <= 0.005 ? 0 : 0.5 * Math.pow(r, 0.7);
}

export function clamp01(x) {
  return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0;
}
