// 人形角色：用方塊拼成（玩家與行人共用）
// 前方為本地 +Z；四肢以肩 / 髖為樞紐擺動
import * as THREE from 'three';
import { cachedStandardMaterial } from './utils.js';

const GEO = {
  leg: new THREE.BoxGeometry(0.17, 0.88, 0.19).translate(0, -0.44, 0),
  shoe: new THREE.BoxGeometry(0.19, 0.1, 0.3).translate(0, -0.9, 0.05),
  torso: new THREE.BoxGeometry(0.46, 0.62, 0.26),
  arm: new THREE.BoxGeometry(0.12, 0.6, 0.14).translate(0, -0.3, 0),
  hand: new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0, -0.65, 0),
  head: new THREE.BoxGeometry(0.26, 0.28, 0.26),
  hair: new THREE.BoxGeometry(0.28, 0.1, 0.28),
};

// colors: { skin, shirt, pants, hair, shoes }
export function createHumanoid(colors = {}) {
  const skin = cachedStandardMaterial(colors.skin || '#f1c9a5');
  const shirt = cachedStandardMaterial(colors.shirt || '#2e7d4f');
  const pants = cachedStandardMaterial(colors.pants || '#2b2f3a');
  const hair = cachedStandardMaterial(colors.hair || '#1b1b1b');
  const shoes = cachedStandardMaterial(colors.shoes || '#222222');

  const g = new THREE.Group();
  const mk = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  };

  const legL = new THREE.Group();
  legL.position.set(-0.12, 0.95, 0);
  legL.add(mk(GEO.leg, pants), mk(GEO.shoe, shoes));
  const legR = new THREE.Group();
  legR.position.set(0.12, 0.95, 0);
  legR.add(mk(GEO.leg, pants), mk(GEO.shoe, shoes));

  const torso = mk(GEO.torso, shirt);
  torso.position.set(0, 1.26, 0);

  const armL = new THREE.Group();
  armL.position.set(-0.3, 1.53, 0);
  armL.add(mk(GEO.arm, shirt), mk(GEO.hand, skin));
  const armR = new THREE.Group();
  armR.position.set(0.3, 1.53, 0);
  armR.add(mk(GEO.arm, shirt), mk(GEO.hand, skin));

  const head = mk(GEO.head, skin);
  head.position.set(0, 1.74, 0);
  const hairMesh = mk(GEO.hair, hair);
  hairMesh.position.set(0, 1.9, -0.01);

  g.add(legL, legR, torso, armL, armR, head, hairMesh);
  g.userData.parts = { legL, legR, armL, armR };
  return g;
}

// 走路擺動：phase 為相位（弧度），amount 0~1 為擺幅
export function animateHumanoid(g, phase, amount) {
  const p = g.userData.parts;
  const s = Math.sin(phase) * amount;
  p.legL.rotation.x = s * 0.7;
  p.legR.rotation.x = -s * 0.7;
  p.armL.rotation.x = -s * 0.6;
  p.armR.rotation.x = s * 0.6;
}

// 騎機車的坐姿
export function poseSitting(g) {
  const p = g.userData.parts;
  p.legL.rotation.x = -1.35;
  p.legR.rotation.x = -1.35;
  p.armL.rotation.x = -1.1;
  p.armR.rotation.x = -1.1;
}
