// 日夜循環：天空色、霧色、太陽 / 月光方向、夜間自發光（窗戶、路燈、招牌、車燈）
// 環境參數單一出口（p5-s1）：每幀把日夜「基準值」寫進 this.base（見下），
// - 未 attach environment（this.env === null，預設）：照舊直接套用到 scene.background / scene.fog.color / hemi / sun
// - attachEnvironment(env) 後：天空 / 霧 / 光的強度與顏色改由 src/environment.js 合成天氣後套用，本模組只管
//   太陽方向與陰影相機跟隨、夜間自發光；scene.fog 的 near / far 本模組從不改（建立時 180 / 720，視距由 main 夾）
// this.base = { hour, elev, day, night, sky, sunColor, sunIntensity, hemiIntensity, hemiSky, hemiGround }
//   （顏色皆為 THREE.Color，與 scene 使用同一色彩空間；environment 只讀 .r/.g/.b）
import * as THREE from 'three';
import { clamp, smoothstep } from './utils.js';

// 夜間發光材質登記表：{ material, max }
// 各模組建立材質時呼叫 registerNight，日夜系統每幀調整 emissiveIntensity
export const nightMaterials = [];
export function registerNight(material, max = 1) {
  nightMaterials.push({ material, max });
  return material;
}

// 天空色關鍵影格（小時, 顏色）
const SKY_KEYS = [
  [0, '#0a0f24'],
  [4.5, '#0d1330'],
  [5.4, '#3a3560'],
  [6.2, '#f2a36b'],
  [7.4, '#a8cdee'],
  [12, '#8ec5f2'],
  [16.5, '#a3c9ea'],
  [17.7, '#f0a060'],
  [18.5, '#6a4a78'],
  [19.4, '#1a1c40'],
  [24, '#0a0f24'],
];
const SKY_COLORS = SKY_KEYS.map(([h, c]) => [h, new THREE.Color(c)]);

// 遊戲時間流速：現實 1 秒 = 遊戲 1 分鐘（一天 24 分鐘）；快轉 ×30
const NORMAL_RATE = 1 / 60;
const FAST_MULT = 30;

export class DayNight {
  constructor(scene, startHour = 16.5) {
    this.scene = scene;
    this.hour = startHour;
    this.fast = false;
    this.night = 0;
    this.env = null; // attachEnvironment 後由 environment 套用天空 / 霧 / 光

    this.skyColor = new THREE.Color();
    scene.background = this.skyColor;
    scene.fog = new THREE.Fog(0xa3c9ea, 180, 720);

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6a48, 1.0);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -110;
    sc.right = 110;
    sc.top = 110;
    sc.bottom = -110;
    sc.near = 10;
    sc.far = 700;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this._dir = new THREE.Vector3();
    this._warm = new THREE.Color(0xffb070);
    this._white = new THREE.Color(0xfff6e8);
    this._moon = new THREE.Color(0x8899ff);
    this._hemiDaySky = new THREE.Color(0xcfe6ff);
    this._hemiNightSky = new THREE.Color(0x6070b0);
    this._hemiDayGround = new THREE.Color(0x5a6a48);
    this._hemiNightGround = new THREE.Color(0x303040);

    this.base = {
      hour: this.hour,
      elev: 0,
      day: 1,
      night: 0,
      sky: new THREE.Color(0xa3c9ea),
      sunColor: new THREE.Color(0xffffff),
      sunIntensity: 2.6,
      hemiIntensity: 1.0,
      hemiSky: new THREE.Color(0xcfe6ff),
      hemiGround: new THREE.Color(0x5a6a48),
    };
  }

  // environment 接手天空 / 霧 / 光的最終套用；傳 null 回到舊路徑
  attachEnvironment(env) {
    this.env = env || null;
  }

  toggleFast() {
    this.fast = !this.fast;
    return this.fast;
  }

  _sampleSky(hour, out) {
    for (let i = 0; i < SKY_COLORS.length - 1; i++) {
      const [h0, c0] = SKY_COLORS[i];
      const [h1, c1] = SKY_COLORS[i + 1];
      if (hour >= h0 && hour <= h1) {
        const t = (hour - h0) / (h1 - h0);
        out.lerpColors(c0, c1, t);
        return out;
      }
    }
    return out.copy(SKY_COLORS[0][1]);
  }

  // focus：玩家位置（陰影相機跟著玩家）
  update(dt, focus) {
    const rate = NORMAL_RATE * (this.fast ? FAST_MULT : 1);
    this.hour = (this.hour + dt * rate) % 24;

    // 太陽角度：6 點從東方升起（+X），12 點天頂，18 點西落
    const ang = ((this.hour - 6) / 12) * Math.PI;
    const elev = Math.sin(ang);
    const day = smoothstep(-0.08, 0.2, elev);
    const night = 1 - smoothstep(-0.12, 0.08, elev);
    this.night = night;

    const b = this.base;
    b.hour = this.hour;
    b.elev = elev;
    b.day = day;
    b.night = night;
    this._sampleSky(this.hour, b.sky);

    if (elev > -0.05) {
      this._dir.set(Math.cos(ang), Math.max(elev, 0.05), 0.35).normalize();
      b.sunColor.lerpColors(this._warm, this._white, smoothstep(0, 0.4, elev));
      b.sunIntensity = Math.max(2.6 * day, 0.25 * night);
    } else {
      // 月光（太陽對面）
      this._dir.set(-Math.cos(ang), Math.max(-elev, 0.2), 0.35).normalize();
      b.sunColor.copy(this._moon);
      b.sunIntensity = 0.7 * night;
    }

    b.hemiIntensity = 0.9 + 0.2 * day; // 夜間保底亮度，避免路面全黑
    b.hemiSky.lerpColors(this._hemiNightSky, this._hemiDaySky, day);
    b.hemiGround.lerpColors(this._hemiNightGround, this._hemiDayGround, day);

    if (!this.env) {
      // 舊路徑：直接套用基準值（行為與 p5-s1 前相同）
      this.skyColor.copy(b.sky);
      if (this.scene.fog) this.scene.fog.color.copy(this.skyColor);
      this.sun.color.copy(b.sunColor);
      this.sun.intensity = b.sunIntensity;
      this.hemi.intensity = b.hemiIntensity;
      this.hemi.color.copy(b.hemiSky);
      this.hemi.groundColor.copy(b.hemiGround);
    }

    // 陰影相機跟隨玩家（對齊到 2m 格子，減少陰影閃爍）
    const fx = Math.round(focus.x / 2) * 2;
    const fz = Math.round(focus.z / 2) * 2;
    this.sun.position.set(fx + this._dir.x * 300, this._dir.y * 300, fz + this._dir.z * 300);
    this.sun.target.position.set(fx, 0, fz);
    this.sun.target.updateMatrixWorld();

    for (const n of nightMaterials) {
      n.material.emissiveIntensity = n.max * night;
    }
  }

  timeString() {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(clamp(m, 0, 59)).padStart(2, '0')}`;
  }
}
