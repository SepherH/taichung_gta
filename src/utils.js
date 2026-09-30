// 共用小工具：固定種子亂數、數學輔助、文字貼圖
import * as THREE from 'three';

// mulberry32：簡單的固定種子亂數產生器，回傳 [0, 1) 的函式
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 平滑插值（e0 可以大於 e1，代表反向）
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// 兩角度之間的最短差值（-π ~ π）
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// 亂數區間
export function randRange(rng, a, b) {
  return a + (b - a) * rng();
}

export function randPick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// 系統字型堆疊（不下載任何字型）
export const FONT_STACK = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", "Noto Sans CJK TC", sans-serif';

// 建立畫布
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// 產生文字貼圖（CanvasTexture）
export function makeTextTexture(text, opts = {}) {
  const width = opts.width || 512;
  const height = opts.height || 128;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = Math.max(4, height * 0.05);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth);
  }
  let fontSize = opts.fontSize || Math.floor(height * 0.62);
  const weight = opts.weight || 'bold';
  ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`;
  // 太長就縮小字級
  const maxW = width * 0.9;
  const measured = ctx.measureText(text).width;
  if (measured > maxW) {
    fontSize = Math.floor(fontSize * (maxW / measured));
    ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.strokeWidth || Math.max(2, fontSize * 0.08);
    ctx.strokeText(text, width / 2, height / 2);
  }
  ctx.fillStyle = opts.color || '#ffffff';
  ctx.fillText(text, width / 2, height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 等下一個畫格（讓載入進度條有機會更新）
export function nextFrame() {
  // 背景分頁不跑 requestAnimationFrame：以逾時保底，載入不會卡在切到別的分頁時
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 60);
  });
}

// 依顏色字串快取材質，避免重複建立
const materialCache = new Map();
export function cachedStandardMaterial(color, extra = {}) {
  const key = color + JSON.stringify(extra);
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...extra });
    materialCache.set(key, m);
  }
  return m;
}

// 文字圖集：把多段文字畫進少數幾張大畫布（減少貼圖與 draw call）
// draw(ctx, x, y, w, h, text) 負責畫一格；回傳 { textures: [CanvasTexture], cells: [{ atlas, u0, v0, u1, v1 }] }
export function buildTextAtlas(texts, cellW, cellH, draw, { size = 2048, anisotropy = 4 } = {}) {
  const cols = Math.max(1, Math.floor(size / cellW));
  const rows = Math.max(1, Math.floor(size / cellH));
  const per = cols * rows;
  const textures = [];
  const cells = [];
  for (let a = 0; a * per < texts.length; a++) {
    const items = texts.slice(a * per, (a + 1) * per);
    const usedRows = Math.ceil(items.length / cols);
    const H = Math.min(size, 2 ** Math.ceil(Math.log2(Math.max(1, usedRows * cellH))));
    const canvas = makeCanvas(size, H);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, H);
    items.forEach((text, k) => {
      const col = k % cols;
      const row = Math.floor(k / cols);
      draw(ctx, col * cellW, row * cellH, cellW, cellH, text);
      // CanvasTexture 預設 flipY：v = 1 為畫布上緣
      cells.push({
        atlas: a,
        u0: (col * cellW) / size,
        u1: ((col + 1) * cellW) / size,
        v1: 1 - (row * cellH) / H,
        v0: 1 - ((row + 1) * cellH) / H,
      });
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    textures.push(tex);
  }
  return { textures, cells };
}

// 在畫布一格內畫置中文字（太長自動縮小字級）
export function fitText(ctx, text, cx, cy, maxW, size, weight = 'bold') {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    size = Math.max(12, Math.floor(size * (maxW / w)));
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  return size;
}
