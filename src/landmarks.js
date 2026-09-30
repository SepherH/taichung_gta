// 手工地標：老虎城、秋紅谷、新光三越、大遠百、臺中市政府、臺中國家歌劇院
// 全部以基本幾何 + CanvasTexture 招牌組成
import * as THREE from 'three';
import { LANDMARKS, QIUHONG_BOWL } from './data/city.js';
import { makeCanvas, makeTextTexture, mulberry32, cachedStandardMaterial } from './utils.js';
import { registerNight } from './daynight.js';

function lm(id) {
  return LANDMARKS.find((l) => l.id === id);
}

function center(r) {
  return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 };
}

// 招牌：板子 + 文字面（預設文字朝 +Z）
// 招牌用 MeshBasicMaterial，白天夜晚都清楚
function makeSign(text, { w = 20, h = 5, depth = 0.6, bg = '#ffffff', color = '#111111', border = null, back = false } = {}) {
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), cachedStandardMaterial(bg));
  board.castShadow = true;
  g.add(board);
  const texW = 1024;
  const texH = Math.max(64, Math.round((texW * h) / w));
  const tex = makeTextTexture(text, { width: texW, height: texH, bg, color, border });
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.98, h * 0.96), faceMat);
  face.position.z = depth / 2 + 0.02;
  g.add(face);
  if (back) {
    const face2 = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.98, h * 0.96), faceMat);
    face2.position.z = -depth / 2 - 0.02;
    face2.rotation.y = Math.PI;
    g.add(face2);
  }
  return g;
}

function box(w, h, d, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function plazaMesh(r, color = 0xcfc9bd, y = 0.04) {
  const c = center(r);
  const geo = new THREE.PlaneGeometry(c.w, c.d);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, cachedStandardMaterial('#' + new THREE.Color(color).getHexString(), { roughness: 0.95 }));
  mesh.position.set(c.x, y, c.z);
  mesh.receiveShadow = true;
  return mesh;
}

// 老虎條紋貼圖
function makeTigerTexture() {
  const W = 512;
  const H = 256;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f28c1a';
  ctx.fillRect(0, 0, W, H);
  const rng = mulberry32(8);
  ctx.fillStyle = '#141414';
  for (let i = 0; i < 12; i++) {
    const x = i * (W / 12) + rng() * 12;
    const len = 110 + rng() * 120;
    const fromTop = i % 2 === 0;
    const y0 = fromTop ? 0 : H;
    const dir = fromTop ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(x - 9, y0);
    ctx.quadraticCurveTo(x + 18, y0 + dir * len * 0.5, x + 4, y0 + dir * len);
    ctx.quadraticCurveTo(x - 4, y0 + dir * len * 0.5, x + 11, y0);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  return tex;
}

// 水平色帶立面（百貨 / 市政府用）
function makeBandTexture(base, band, { bands = 14, vertical = false } = {}) {
  const S = 256;
  const canvas = makeCanvas(S, S * 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S * 2);
  ctx.fillStyle = band;
  if (vertical) {
    const step = S / bands;
    for (let i = 0; i < bands; i++) ctx.fillRect(i * step + step * 0.3, 0, step * 0.4, S * 2);
  } else {
    const step = (S * 2) / bands;
    for (let i = 0; i < bands; i++) ctx.fillRect(0, i * step + step * 0.35, S, step * 0.45);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 回傳 { group, boxes }
export function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  scene.add(group);
  const boxes = [];
  const roofMat = cachedStandardMaterial('#3a3a3a');

  // ---------- 老虎城 ----------
  {
    const L = lm('tiger');
    const f = center(L.footprint);
    const h = L.height;
    group.add(plazaMesh(L.plaza, 0xd6cfc2));
    const stripeMat = new THREE.MeshStandardMaterial({ map: makeTigerTexture(), roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(f.w, h, f.d), [stripeMat, stripeMat, roofMat, roofMat, stripeMat, stripeMat]);
    body.position.set(f.x, h / 2, f.z);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const black = cachedStandardMaterial('#161616');
    group.add(box(f.w + 0.8, 2.4, f.d + 0.8, black, f.x, h - 1.1, f.z)); // 頂面略高於屋頂，避免 z-fighting
    // 入口玻璃與雨遮（北側）
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x5a7a98, emissive: 0xffc070, emissiveIntensity: 0, roughness: 0.25, metalness: 0.1 });
    registerNight(glassMat, 0.8);
    group.add(box(26, 7, 0.6, glassMat, f.x, 3.5, L.footprint.z0 - 0.2));
    group.add(box(34, 0.6, 5, black, f.x, 7.8, L.footprint.z0 - 2.5));
    // 立面大字 TIGER CITY（朝北）
    const front = makeSign('TIGER CITY', { w: 46, h: 7, bg: '#141414', color: '#ff8c1a' });
    front.position.set(f.x, 13.5, L.footprint.z0 - 0.7);
    front.rotation.y = Math.PI;
    group.add(front);
    // 屋頂中文招牌「老虎城」（前後雙面）
    const top = makeSign('老虎城', { w: 28, h: 8, bg: '#f28c1a', color: '#141414', back: true });
    top.position.set(f.x, h + 5.5, L.footprint.z0 + 6);
    top.rotation.y = Math.PI;
    group.add(top);
    group.add(box(1, 2, 1, black, f.x - 10, h + 1, L.footprint.z0 + 6));
    group.add(box(1, 2, 1, black, f.x + 10, h + 1, L.footprint.z0 + 6));
    // 側面招牌（東西兩側）
    for (const s of [-1, 1]) {
      const side = makeSign('TIGER CITY 老虎城', { w: 30, h: 4, bg: '#141414', color: '#ff8c1a' });
      side.position.set(s > 0 ? L.footprint.x1 + 0.7 : L.footprint.x0 - 0.7, 16, f.z);
      side.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
      group.add(side);
    }
    boxes.push({ ...L.footprint, h, name: 'tiger' });
  }

  // ---------- 秋紅谷 ----------
  {
    const b = QIUHONG_BOWL;
    const waterGeo = new THREE.CircleGeometry(1, 40);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x3f7fa8, roughness: 0.12, metalness: 0.3 });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.scale.set(b.pondRX * 0.92, 1, b.pondRZ * 0.92);
    water.position.set(b.pondX, b.waterY, b.pondZ);
    group.add(water);
    // 石碑招牌（在臺灣大道側）
    const sign = makeSign('秋紅谷', { w: 9, h: 2.2, depth: 1.2, bg: '#5b5f55', color: '#ffffff', back: true });
    sign.position.set(-340, 1.3, b.z0 - 1.2);
    sign.rotation.y = Math.PI;
    group.add(sign);
    boxes.push({ x0: -344.5, x1: -335.5, z0: b.z0 - 1.8, z1: b.z0 - 0.6, h: 2.4, name: 'qiuhong-sign' });
    // 水池中的步道橋
    const deckMat = cachedStandardMaterial('#8a6a4a');
    group.add(box(3, 0.3, b.pondRZ * 2 + 6, deckMat, b.pondX + 8, b.waterY + 0.35, b.pondZ));
  }

  // ---------- 新光三越、大遠百 ----------
  {
    const S = lm('skm');
    const F = lm('ftc');
    group.add(plazaMesh(S.plaza, 0xd2cdc4));
    const skmTex = makeBandTexture('#e9e1d2', '#8e9aa6', { bands: 18 });
    const ftcTex = makeBandTexture('#dfe3e6', '#4d6178', { bands: 16, vertical: true });
    const skmMat = new THREE.MeshStandardMaterial({ map: skmTex, roughness: 0.6 });
    const ftcMat = new THREE.MeshStandardMaterial({ map: ftcTex, roughness: 0.5, metalness: 0.1 });
    const s = center(S.footprint);
    const f = center(F.footprint);
    const skm = new THREE.Mesh(new THREE.BoxGeometry(s.w, S.height, s.d), [skmMat, skmMat, roofMat, roofMat, skmMat, skmMat]);
    skm.position.set(s.x, S.height / 2, s.z);
    skm.castShadow = true;
    skm.receiveShadow = true;
    group.add(skm);
    const ftc = new THREE.Mesh(new THREE.BoxGeometry(f.w, F.height, f.d), [ftcMat, ftcMat, roofMat, roofMat, ftcMat, ftcMat]);
    ftc.position.set(f.x, F.height / 2, f.z);
    ftc.castShadow = true;
    ftc.receiveShadow = true;
    group.add(ftc);
    // 低樓層裙樓
    const podium = cachedStandardMaterial('#c8c0b2');
    group.add(box(s.w + 4, 10, s.d + 4, podium, s.x, 5, s.z));
    group.add(box(f.w + 4, 10, f.d + 4, cachedStandardMaterial('#b8c0c8'), f.x, 5, f.z));
    // 招牌（朝北面向臺灣大道 + 屋頂）
    const skmSign = makeSign('新光三越', { w: 30, h: 7, bg: '#ffffff', color: '#c8102e' });
    skmSign.position.set(s.x, S.height - 8, S.footprint.z0 - 0.7);
    skmSign.rotation.y = Math.PI;
    group.add(skmSign);
    const skmTop = makeSign('新光三越', { w: 26, h: 6, bg: '#c8102e', color: '#ffffff', back: true });
    skmTop.position.set(s.x, S.height + 4, s.z);
    skmTop.rotation.y = Math.PI;
    group.add(skmTop);
    const ftcSign = makeSign('大遠百', { w: 24, h: 7, bg: '#0b3d91', color: '#ffffff' });
    ftcSign.position.set(f.x, F.height - 8, F.footprint.z0 - 0.7);
    ftcSign.rotation.y = Math.PI;
    group.add(ftcSign);
    const ftcTop = makeSign('大遠百', { w: 22, h: 6, bg: '#ffffff', color: '#0b3d91', back: true });
    ftcTop.position.set(f.x, F.height + 4, f.z);
    ftcTop.rotation.y = Math.PI;
    group.add(ftcTop);
    boxes.push({ x0: S.footprint.x0 - 2, x1: S.footprint.x1 + 2, z0: S.footprint.z0 - 2, z1: S.footprint.z1 + 2, h: S.height, name: 'skm' });
    boxes.push({ x0: F.footprint.x0 - 2, x1: F.footprint.x1 + 2, z0: F.footprint.z0 - 2, z1: F.footprint.z1 + 2, h: F.height, name: 'ftc' });
  }

  // ---------- 臺中市政府 ----------
  {
    const C = lm('cityhall');
    group.add(plazaMesh(C.plaza, 0xd9d6ce));
    const finTex = makeBandTexture('#eef0f0', '#9aa4ac', { bands: 20, vertical: true });
    const finMat = new THREE.MeshStandardMaterial({ map: finTex, roughness: 0.6 });
    for (const r of C.buildings) {
      const c = center(r);
      const m = new THREE.Mesh(new THREE.BoxGeometry(c.w, C.height, c.d), [finMat, finMat, roofMat, roofMat, finMat, finMat]);
      m.position.set(c.x, C.height / 2, c.z);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
      boxes.push({ ...r, h: C.height, name: 'cityhall' });
    }
    // 兩棟之間的頂部連接板
    const w0 = C.buildings[0];
    const w1 = C.buildings[1];
    const bridgeW = w1.x0 - w0.x1;
    group.add(box(bridgeW + 4, 3, 14, cachedStandardMaterial('#e4e6e6'), (w0.x1 + w1.x0) / 2, C.height - 1.5, (w0.z0 + w0.z1) / 2));
    // 中央廣場：草皮、旗桿、招牌
    const plazaCx = (w0.x1 + w1.x0) / 2;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(bridgeW - 20, 20), cachedStandardMaterial('#6f9a58'));
    grass.geometry.rotateX(-Math.PI / 2);
    grass.position.set(plazaCx, 0.07, -238);
    grass.receiveShadow = true;
    group.add(grass);
    const poleMat = cachedStandardMaterial('#d0d4d8', { metalness: 0.6 });
    for (let i = -1; i <= 1; i++) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 14, 8), poleMat);
      pole.position.set(plazaCx + i * 6, 7, -258);
      pole.castShadow = true;
      group.add(pole);
    }
    const sign = makeSign('臺中市政府', { w: 22, h: 3.2, depth: 1.2, bg: '#2f3a44', color: '#ffffff', back: true });
    sign.position.set(plazaCx, 1.8, -264);
    sign.rotation.y = Math.PI;
    group.add(sign);
    boxes.push({ x0: plazaCx - 11, x1: plazaCx + 11, z0: -265, z1: -263, h: 3.4, name: 'cityhall-sign' });
    const topSign = makeSign('臺中市政府', { w: 30, h: 5, bg: '#ffffff', color: '#1f4e79' });
    topSign.position.set(plazaCx, C.height + 3, (w0.z0 + w0.z1) / 2 - 7.2);
    topSign.rotation.y = Math.PI;
    group.add(topSign);
  }

  // ---------- 臺中國家歌劇院 ----------
  {
    const O = lm('opera');
    group.add(plazaMesh(O.plaza, 0xdedad2));
    const f = center(O.footprint);
    const h = O.height;
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.55 });
    // 圓角矩形擠出（近似曲面外觀）
    const roundedShape = (w, d, r) => {
      const s = new THREE.Shape();
      const x = -w / 2;
      const y = -d / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + w - r, y);
      s.quadraticCurveTo(x + w, y, x + w, y + r);
      s.lineTo(x + w, y + d - r);
      s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
      s.lineTo(x + r, y + d);
      s.quadraticCurveTo(x, y + d, x, y + d - r);
      s.lineTo(x, y + r);
      s.quadraticCurveTo(x, y, x + r, y);
      return s;
    };
    const mainGeo = new THREE.ExtrudeGeometry(roundedShape(f.w, f.d, 16), { depth: h, bevelEnabled: false, curveSegments: 10 });
    mainGeo.rotateX(-Math.PI / 2);
    const main = new THREE.Mesh(mainGeo, white);
    main.position.set(f.x, 0, f.z);
    main.castShadow = true;
    main.receiveShadow = true;
    group.add(main);
    const roofGeo = new THREE.ExtrudeGeometry(roundedShape(f.w - 24, f.d - 12, 10), { depth: 3, bevelEnabled: false, curveSegments: 8 });
    roofGeo.rotateX(-Math.PI / 2);
    const roof = new THREE.Mesh(roofGeo, white);
    roof.position.set(f.x, h, f.z);
    roof.castShadow = true;
    group.add(roof);
    // 立面的「洞穴」開口（深色橢圓，夜晚透出暖光）
    const caveMat = new THREE.MeshStandardMaterial({ color: 0x2c2e34, emissive: 0xffb070, emissiveIntensity: 0, roughness: 0.4, side: THREE.DoubleSide });
    registerNight(caveMat, 1.2);
    const caveGeo = new THREE.CircleGeometry(1, 28);
    const flatHalf = f.w / 2 - 18;
    for (let i = 0; i < 5; i++) {
      const x = f.x - flatHalf + (i * flatHalf * 2) / 4;
      const tall = i % 2 === 0;
      for (const side of [-1, 1]) {
        const cave = new THREE.Mesh(caveGeo, caveMat);
        cave.scale.set(tall ? 6 : 5, tall ? 9 : 6.5, 1);
        cave.position.set(x, tall ? 11 : 15, side < 0 ? O.footprint.z0 - 0.05 : O.footprint.z1 + 0.05);
        if (side < 0) cave.rotation.y = Math.PI;
        group.add(cave);
      }
    }
    // 招牌：南側（面向市政北二路）與北側
    const southSign = makeSign('臺中國家歌劇院', { w: 26, h: 3.2, depth: 1.2, bg: '#3a3a3a', color: '#ffffff' });
    southSign.position.set(f.x, 1.8, O.footprint.z1 + 5);
    group.add(southSign);
    boxes.push({ x0: f.x - 13, x1: f.x + 13, z0: O.footprint.z1 + 4.2, z1: O.footprint.z1 + 5.8, h: 3.4, name: 'opera-sign' });
    const roofSign = makeSign('臺中國家歌劇院', { w: 34, h: 5, bg: '#ffffff', color: '#333333', back: true });
    roofSign.position.set(f.x, h + 6, f.z);
    group.add(roofSign);
    boxes.push({ ...O.footprint, h: h + 3, name: 'opera' });
  }

  return { group, boxes };
}
