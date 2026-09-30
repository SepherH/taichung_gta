// 日夜循環：天空色、霧色、太陽 / 月光方向、夜間自發光（窗戶、路燈、招牌、車燈）
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

    this._sampleSky(this.hour, this.skyColor);
    this.scene.fog.color.copy(this.skyColor);

    if (elev > -0.05) {
      this._dir.set(Math.cos(ang), Math.max(elev, 0.05), 0.35).normalize();
      this.sun.color.lerpColors(this._warm, this._white, smoothstep(0, 0.4, elev));
      this.sun.intensity = Math.max(2.6 * day, 0.25 * night);
    } else {
      // 月光（太陽對面）
      this._dir.set(-Math.cos(ang), Math.max(-elev, 0.2), 0.35).normalize();
      this.sun.color.copy(this._moon);
      this.sun.intensity = 0.7 * night;
    }

    this.hemi.intensity = 0.9 + 0.2 * day; // 夜間保底亮度，避免路面全黑
    this.hemi.color.lerpColors(this._hemiNightSky, this._hemiDaySky, day);
    this.hemi.groundColor.lerpColors(this._hemiNightGround, this._hemiDayGround, day);

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
