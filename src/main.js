// 臺中GTA 進入點（Phase 3 整合）：建立場景、分步載入、選單流程、存檔經濟、主迴圈（世界依真實 OSM 資料生成）
// 地形一律取 terrain（唯一高度場）：querySurface 注入給 player / vehicle / traffic / camera；秋紅谷與下沉廣場細節網格由 qiuhonggu.js 產生
// 物理（Rapier，src/physics/**）：世界碰撞體取真實 terrain（heightfield / walkable / 湖面）與 buildings.js 的建築 colliders；
// 主迴圈 = 每幀讀輸入快照（input.snapshot）→ PhysicsWorld.step(dt)（固定 1/60 s 子步：子步前號誌相位 / 角色 move / 車輛 preStep / 車流 kinematic pose，
// 子步後 contacts router.drain / 耐久去重時鐘與停放 / wrecked / 倒地狀態）→ 號誌燈色 → combat.update → 以插值結果同步網格 → 車輛耐久 / 煙 → 鏡頭 / HUD → 渲染
//   每幀排程與物理一幀的順序在 core/loop.js；模擬計時（號誌、對抗時鐘、KO、回收）吃物理實際推進的秒數（docs/dev/interfaces.md「時間步契約」）
// 核心樞紐（docs/dev/interfaces.md）：bus（core/events 單例）串起選單 / 經濟 / 耐久 / 搶車 / 喇叭；settings（core/settings 單例）驅動
//   靈敏度、反轉 Y、畫質（人車數即時 traffic.setBudget，DPR / 陰影 / 視距即時重套）、介面大小、FPS 顯示、新手提示
// 選單流程：載入完成 → 開始畫面（背景環繞鏡頭）→ game:start（繼續 = 還原存檔）→ 遊戲；Esc / P / 觸控暫停鈕 / pointer lock 被解除 → 暫停選單
//   （世界停止更新、照常渲染、input.enabled = false）；「繼續」在同一手勢內 requestPointerLock；回主選單 = 存檔後回開始畫面
// 按鍵一律讀 core/actions 的 action：左鍵 / 觸控攻擊 = 攻擊、F 上下車 / 搶車 / 扶起、H 喇叭、V 鏡頭段、C 回頭看、M 地圖、Esc / P 暫停、N 快轉
// 上車：enter_car 動作播完（animator 自動進 drive）才真正進駕駛，期間鎖輸入；搶車（carjack.js）期間 state.mode = 'carjack' 同樣鎖輸入
// Phase 4 接線（docs/dev/interfaces.md §10–§19、附錄 B）：
//   武器 createWeapons（raycast / sweep = PhysicsWorld.castRay / intersections + contacts router 的 collider → 行人 actor）、
//   模型掛 hero weapon_socket、player.weaponLayer 姿勢 / 動作 / 後座、肩後鏡頭（瞄準中滾輪不縮放）、槍聲 → 行人 hear、彈藥拾取、武器 HUD；
//   combat 'hit' → combat:hit → 血跡 blood.onHit、ped:knockdown → blood.onKnockdown（bat / bullet 擊倒也掉錢）；
//   程序音效 createAudio（手勢 unlock、每幀 update）；委託 missions / 導航 nav / 大地圖 bigMap（M）/ 打卡 checkins / 小吃圖鑑 food（G 或選單）；
//   interactable 仲裁（任務 3 > 打卡 2 > 小吃 1 > 彈藥 0，同級取近）→ 互動提示、E 執行；
//   全螢幕面板（接單 / 結算、大地圖、圖鑑）開啟時世界與輸入暫停，大地圖 / 圖鑑開啟時不渲染 3D；存檔 v2（weapons / missions / collect）
// Phase 5 接線（docs/dev/interfaces.md §21）：
//   天氣 createWeather + 環境 createEnvironment（attach dayNight；每幀 dayNight.update → weather.update(dt, worldStep.simDt) → env.update）、
//   視距改走 env.setViewDist、畫質切換 weather.setQuality、設定 weather（自動 / 晴 / 雨 / 霧）、雨聲 audioState.rain；
//   車上電台 createRadio（getAudio = audio.getOutput、駕駛中 Q = radioNext → radio.next()、觸控 tb-radio 由 hud.js 註冊）；
//   時段事件（夜市外送）：missions 注入 getGameHour / routeLength、event:* 提示、HUD / 大地圖 event-start / event-dest 標記（顏色 / 圖例由 hud.js / big-map.js 定義）、
//   存檔 missions.events、完成 / 失敗計入 missionsDone / missionsFailed（trackMissionStats）
// 垃圾車事件 / 夜市攤車（docs/dev/interfaces.md §22）：
//   createMissions 注入 routeFor = garbageTruckRoute（玩家附近 150–300 m 的道路點 → 更遠的道路點，findRoute 折線）；
//   垃圾車車體 = createVehicleModel('garbage_truck') 純視覺（無剛體、不可上車 / 劫車、不進 traffic），每幀依 missions.truckState() 擺位、null 隱藏，
//   beacon 等發光材質 registerNight；音效 state.garbageTruckDist（無車 Infinity）→ audio LOOPS.garbage_truck；小地圖 / 大地圖標記 kind event-truck；
//   missions.update 吃 worldStep.simDt（§20：暫停 / 面板開啟不推進、卡頓丟棄的時間不算）；
//   夜市攤車 = loadPropModels → createPropModel('night_market_stall')，placeProp 擺在夜市外送取餐點旁離牆較遠的路側、+Z 面向道路，
//     物理世界建好後 colliders.addStaticBox 補 WORLD 組靜態方塊（各畫質皆擺）
// 遊戲內手機（I6b，§23.3）：createPhone（ui/phone.js）+ createPhoneLink（ui/phone-link.js 開關互斥 / 鎖輸入 / 資料注入）；
//   T（actions phone）/ 觸控 tb-phone（tl4）在 started && !paused && !panelOpen() && !menu.isOpen() 時開；手機不列入 panelOpen（世界照跑），
//   開啟中 input.enabled = false（syncPhone）；任務 App = missions.listings(focus)、導航 → nav.setDestination(…, 'phone')、
//   地圖 App → 關手機開大地圖、設定 App → 關手機開暫停選單設定頁；Esc / T / 返回鈕由 phone.js keydown capture 處理
// 打工委託（I6c，§23.4 / §24）：createMissions 注入 jobSpots（夜市跑單 = oyster 攤 + 攤主側 stallBack + sidewalkNear、代客泊車 = job-props.js VALET_SITES）、
//   spawnValetCar（vehicles.adopt + dmg.attach）/ releaseValetCar（拉手煞轉路邊停放、遠了回收）/ healthOf（dmg.healthOf）；missionCtx.vehicle = 駕駛中的車；
//   夜市攤位 = 原攤車 + oyster / tea 變體混擺（缺模型退回原攤車）、泊車亭 valet_stand（缺模型退回程式幾何，碰撞只取亭身）、接單攤檯面 takeout_bag
// 超商搶劫（Phase 9，§28）：createRobberies（wanted/robbery.js 純邏輯）+ 店員（pedestrian 角色綠制服、combat actor clerkOf = 店 id、行人膠囊剛體）
//   + 門口小光柱（只在可搶時）+ 小地圖 / 大地圖 kind 'store'；每幀 updateRobberies 接在 updateSprayShops 之後（手機 / 暫停 / 面板 / BUSTED・WASTED / 噴漆中不推進），
//   aiming / aimAt 取 fillAim 的 aim（aim.aiming = 按住瞄準且持手槍；aimAt = 鏡頭中心射線離店員胸口 ≤ 1.2 m）
// 警車任務（Phase 11，§29 Vigilante）：createVigilante（missions/vigilante.js 純邏輯）+ createFugitiveWorld（逃犯車 = vehicles.adopt + dmg.attach、
//   生成點 traffic.spawnSpots、沿 findRoute 路網逃竄、制伏時 traffic.spawnEjectedDriver）+ 任務條 .vig-bar + 小地圖 / 大地圖 kind 'fugitive'；
//   駕駛警車時互動鍵（E / 手把 B / tb-interact）優先給 vigilanteInteractable；每幀 updateVigilante 接在 updateRobberies 之後
//   （手機 / 暫停 / 面板 / BUSTED・WASTED / 噴漆 / 搶劫中不推進）；任務中攻擊下車逃犯 / 射擊逃犯車不報案、beginRespawn 結束任務（皆經通緝段宣告的 vigHooks）
// 幫派地盤（V2，§30）：createGangs（gangs.js 純邏輯，Traffic 之前建立、pedHooks 交給 Traffic 換裝成員）+ createGangCars（幫派車）；
//   每幀 updateGangs 接在 updateVigilante 之後（手機 / BUSTED・WASTED / 噴漆 → frozen）；gang:enter / gang:hostile / gang:driveby → toast；
//   小地圖 hud state.gangZones、大地圖 zones = GANG_ZONES；開新局 / 回主選單 → gangs.cancel()，被捕 / 送醫 → gangs 訂閱 player:busted / player:wasted 歸零；
//   車內中彈 hp 歸零 → 強制下車倒地走 WASTED
// V3 街頭隨機犯罪事件（§32）：createStreetEvents（street-events.js 純邏輯排程）+ createStreetWorld（徵用骨架行人 / 事件車 / 既有警車 adapters / gangs.skirmish）；
//   每幀 updateStreetEvents 接在 updateExplosions / handleCarKo 之後（手機 / BUSTED・WASTED / 噴漆 → 凍結；搶劫 / 警車任務 / 委託類 → 不生成新事件、既有照常收尾）；
//   事件歹徒 / 罪犯車經 vigHooks 豁免犯行；street:start 80 m 內 toast、小地圖 kind 'street-event' 黃點閃爍；開新局 / 回主選單 → cancelStreetEvents()
// 街頭競速（Phase 12，§34）：createRaces（missions/race.js 純邏輯，RACES 三條七期地標賽道）+ createRivalWorld（對手車 = vehicles.adopt + dmg.attach、
//   沿 findRoute 路網開往下一檢查點）+ createRaceHud（任務條 / 倒數 / 方向箭頭）+ 起點橘色光柱、檢查點大光柱圈 + 小地圖旗幟 'race-start' / 'race-cp'；
//   駕車進起點光柱時互動鍵（E / 手把 B / tb-interact）優先給 raceInteractable（有星數 toast 不開賽）；倒數中玩家車煞停（races.locked）；
//   每幀 updateRace 接在 updateVigilante 之後（手機 / 暫停 / 面板 / BUSTED・WASTED / 噴漆 / 搶劫 / 警車任務中不推進、對手車煞停）；
//   互斥：state.racing（getter）併入 otherMissionBusy（警車任務）與搶劫守門、vigHooks.active 併入（委託類 / 噴漆）；比賽中犯行照常；
//   vigHooks.end 併入退賽（BUSTED / WASTED）；開新局 / 回主選單 → cancelRace()；最佳成績存檔 races.best（races.serialize / restore）
// 計程車 / 救護車副任務（Phase 13，§35）：createTaxi / createEms（missions/taxi.js / ems.js 純邏輯）+ createCurbPedWorld（招手乘客 / 倒地傷患 = 徵用 traffic.peds）
//   + createSideJobBar（.taxi-bar / .ems-bar）+ 目的地 / 醫院光柱 + 小地圖 'taxi-fare' / 'taxi-dest' / 'ems-patient' / 'ems-hospital'；救護車 = createAmbulanceDepot
//   在醫院旁生成 suv 白車 + 紅條 + 頂燈（emissive 方塊閃爍，不加光源 / 貼圖）；駕駛計程車 / 救護車時互動鍵開始 / 收工（後備：競速 / 警車 / 委託 / 打卡都沒有時才出現）；
//   每幀 updateSideJobs 接在 updateGangs 之後（手機 / 暫停 / BUSTED・WASTED / 噴漆中不推進，但傷患倒地計時照刷）；互斥：state.sideJob（getter）併入 otherMissionBusy 與搶劫守門、
//   vigHooks.active / end 包裝（委託類 / 噴漆 / BUSTED・WASTED）；開新局 / 回主選單 → cancelSideJobs()
// Phase 14 衝鋒槍 / 散彈槍 / 武器店 / 安全屋：weapons 五槽（Digit4 / Digit5 以 SLOT_KEYS 直接讀鍵，不進 ACTIONS；手把十字鍵 ← 讀 weapons.prevSlot）、
//   槍械（isGun）都按住連發（間隔由 weapons 控制）、長槍持握以 pistol_aim 近似雙手（無雙手 clip）、模型 weaponModels[id]；
//   不放地圖彈藥盒（手槍備彈無限；衝鋒槍 / 散彈槍彈藥只在武器店購買或取得武器時附贈）；
//   createGunShop（src/shops/gun-shop.js）/ createSafehouses（src/shops/safehouse.js）：門口小光柱（各自 createBeaconPool）、小地圖 / 大地圖 kind
//   'gun-shop' / 'safehouse'、步行互動經 nearestInteractable 仲裁（priority 2，委託 3 優先；搶車 F 與駕駛副任務不同鍵 / 不同模式）；
//   武器店面板併入 panelOpen（開著時世界與輸入暫停）；每幀 updateShops 接在 updateStreetEvents 之後；開新局 / 回主選單 → cancelShops()；
//   安全屋：存檔 + 回滿血 + 通緝清零、存檔 safehouse.last、繼續遊戲從該安全屋出生；死亡（WASTED）/ 被捕沿用既有規則：武器與彈藥保留
// 暴走任務（Phase 15，§37 Rampage）：createRampage（missions/rampage.js 純邏輯，RAMPAGES 三幫地盤 + 市區 4 處）+ createRampageWorld（補敵人 = gangs.enlist 徵用附近骨架行人）
//   + createRampageHud（.rampage-bar 任務條 / .rampage-edge 畫面邊緣紅色脈動）+ createSkullMarkers（旋轉紅色低模骷髏，emissive、無光源 / 貼圖 / 陰影）+ 小地圖骷髏 'rampage'；
//   步行走進骷髏即開始（駕車經過不觸發）、暫發武器結束收回（rampage.js 內 weapons.serialize 快照 / restore）；每幀 updateRampage 接在 updateShops 之後
//   （手機 / 暫停 / 面板 / BUSTED・WASTED / 噴漆中不推進）；互斥：state.rampage（getter）、state.racing getter 包裝併入（otherMissionBusy / 搶劫守門）、
//   vigHooks.active / end 包裝（委託類 / 噴漆 / BUSTED・WASTED）、進行中不問委託 / 武器店 / 安全屋；通緝照常；存檔 rampage.done、進行中存開始前的武器；
//   開新局 / 回主選單 → cancelRampage()
// 特技跳台（Phase 16，§38 Unique Stunt Jumps）：createStunts（src/stunts.js 純邏輯，STUNTS 全城 5 處）+ createRampMesh（全部坡道合成 1 個 Mesh、頂點色黃黑條紋，
//   無貼圖 / 陰影）+ addRampColliders（每處一個 WORLD 組靜態凸包）+ createStuntHud（.stunt-panel 結算面板 3 s）+ 小地圖 / 大地圖 'stunt' / 'stunt-done'（淡化）；
//   每幀 updateStunts(realDt) 接在 updateRampage 之後（吃實際幀時間：慢動作時長與幀率 / timeScale 無關）；慢動作 = updateGame 開頭 dt *= stunts.timeScale
//   （之後的物理 / AI / 動畫 / 任務計時全吃縮放後的 dt；音效 updateAudio 在 updateGame 之外不受影響）；電影鏡頭 applyStuntCam 接在 rig.update / tour.handoff 之後
//   （以 stunts.cam.weight 內插位置 / slerp 朝向，結束平滑交回跟車鏡頭）；互斥：stuntBusy = otherMissionBusy() || vigilante.active || rampage.active || !!state.respawn → 起飛不觸發、
//   跳躍中轉 busy（空中被捕 / 死亡）→ 立即無聲中止（不含通緝星數）；
//   存檔 stunts.done；開新局 / 回主選單 → cancelStunts()
// 隱藏包裹（Phase 17，Hidden Packages）：createPackages（src/collect/packages.js 純邏輯，PACKAGES 全城 20 處）+ createPackageMesh（20 個太陽餅盒 = 1 個 InstancedMesh、
//   頂點色、無貼圖 / 光源 / 陰影）；每幀 updatePackages(dt) 接在 updateStunts 之後（玩家 / 駕駛車身位置進 2.5 m 自動收集；60 m 內才更新旋轉）；
//   大地圖只標已收集者（kind 'package' 淡化，collectMarkers 不含車輛時才加）、圖例統計列「隱藏包裹 N / 20」、暫停選單統計頁同列；
//   bus safehouse:enter → packages.resupply({ save })（依已達里程碑以 weapons.give / addAmmo 補給；有補到才 autosave.flush('safehouse-resupply') 入檔，存檔結果併入補給 toast）；存檔 packages；開新局 / 回主選單 → cancelPackages()
// 消防車任務（P18，Firefighter）：createFirefighter（src/missions/firefighter.js 純邏輯，關卡 1–12）+ createFireWorld（起火車 = vehicles.adopt + dmg.attach
//   + explosions.damageVehicle 點燃 / setFuse 延長引信 / extinguish 熄滅；驚慌乘客 = traffic.spawnEjectedDriver 逃跑）+ createFireTruckDepot（消防局黎明分隊前庭停放、
//   門口小光柱 BEACON_COLORS.fire）+ createWaterCannonMesh（水柱 1 個 InstancedMesh）+ 任務條 .fire-bar + 小地圖 'fire'；駕駛消防車按住射擊鍵噴水（車頭方向、射程 15 m）；
//   水砲輸入：Mouse0 / 備援 KeyX（FIRE_SPRAY_KEY）、觸控 tb-spray（出勤中駕駛消防車才顯示）、手把 X（getSprayMode：駕駛消防車時喇叭改水砲）；
//   每幀 updateFirefighter 接在 updatePackages 之後（手機 / BUSTED・WASTED / 噴漆中不推進，改呼叫 firefighter.hold(dt) 延後起火車引信）；駕駛中互動鍵後備鏈 sideJobInteractable → firefighterInteractable；
//   互斥：state.firefighter（getter）、state.racing getter 包裝併入（otherMissionBusy / 搶劫守門 / 暴走 / 特技跳台）、vigHooks.active / end 包裝；
//   出勤條件 fireBusy = otherMissionBusy() || vigilante.active || rampage.active || stunts.active || 重生 / 噴漆中；
//   第 12 關完成 → 永久防火（explosions.setFireproof：玩家正駕駛的車）+ autosave.flush('firefighter')；存檔 firefighter；開新局 / 回主選單 → cancelFirefighter()（先於 clearExplosions）
// 故事任務線第一章「七期夜雨」（P20，Story）：createStory（src/missions/story.js 純邏輯，S1 送貨 / S2 追債 / S3 清場，聯絡人阿海在 KTV 後巷「S」）+ storyWorld 轉接
//   （S1 貨車 = vehicles.adopt + dmg.attach；S2 叛徒車 = 第二個 createFugitiveWorld；S3 對手幫派 = 第二個 createRampageWorld + gangs.provokeGang）+ createStoryHud（任務條 / 字幕框）+ S 小光柱；
//   每幀 updateStory 接在 updateSnatch 之後（手機 / BUSTED・WASTED / 噴漆中凍結）；對白：互動鍵下一句、STORY_SKIP_KEY（Enter）整段跳過（storyInteractable 於步行 / 駕駛提示鏈最後覆蓋）；
//   互斥：state.story（getter）、包裝 state.racing getter（otherMissionBusy / 搶劫 / 暴走 / 特技 / 消防 / 副任務 / 競速皆擋）、vigHooks.active / end（委託類 / 噴漆 / BUSTED・WASTED → 任務失敗）；
//   nearestInteractable 故事任務中不接委託；存檔 story（{ chapter, done, unlocked }）；章節獎勵 → 安全屋專屬座車 storyCars + autosave.flush('story')；開新局 / 回主選單 → cancelStory()
import * as THREE from 'three';
import './style.css';
import osm from './data/osm-city.json';
import { SURFACE_OFFSET, TRIVIA } from './data/city.js';
import { LoadingScreen } from './loading.js';
import { Input } from './input.js';
import { createGamepad } from './gamepad.js';
import { registerTouchButton, setTouchButtonVisible } from './touch.js';
import { PhysicsOccluder } from './collision.js';
import { buildWorld, describeLocation } from './world.js';
import { buildQiuhonggu } from './qiuhonggu.js';
import { buildBuildings } from './buildings.js';
import { loadLandmarkModels, projectLatLon } from './landmarks/index.js';
import { computeSpawn, computeParkedVehicles } from './places.js';
import { ATTRIBUTION, buildingAt, buildings as cityBuildings, getTerrain, heightAt, inBounds, inWater, namedBuildings, nearestNamedRoad, onRoadSurface, parks, surfaceFootways, surfaceRoads } from './citymodel.js';
import { loadCharacterModels, getCharacterManifest, createCharacter, disposeCharacter, repaintCharacter, CharacterAnimator } from './characters/index.js';
import { loadVehicleModels, createVehicleModel, vehicleTemplateMaterials, EMISSIVE_MATERIALS, SEAT_HIPS_HEIGHT } from './vehicle-model.js';
import { loadPropModels, createPropModel, propInfo, propEmissiveMaterials, placeProp, propColliderBox } from './prop-model.js';
import { STALL_BASE_KEY, TAKEOUT_BAG_KEY, TAKEOUT_BAG_LOCAL, VALET_SITES, VALET_STAND_KEY, buildValetStandFallback, createSidewalkNear, runStallSpot, stallRow, valetSpots, valetStandBoxes } from './job-props.js';
import { CombatSystem, pedKnockdownPayload } from './combat.js';
import { Player, PLAYER_RADIUS } from './player.js';
import { VehicleManager, VEHICLE_TYPES, driveControls } from './vehicle.js';
import { Traffic } from './traffic.js';
import { createTrafficLights } from './traffic-lights.js';
import { createCarjack } from './carjack.js';
import { DAMAGE_EXP, DAMAGE_MIN_SPEED, createVehicleDamage, impactDamage } from './vehicle-damage.js';
import { createExplosions, shakeTrauma } from './explosions.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { DayNight, nightMaterials, registerNight } from './daynight.js';
import { createWeather, WEATHER_KINDS } from './weather.js';
import { createEnvironment } from './environment.js';
import { createPostFx, loadPostFxPasses } from './postfx.js';
import { nextFrame } from './utils.js';
import { applyRendererQuality, createAdaptiveResolution, isInputBlocked, isTouch, pixelRatioFor, qualityTier, setGameActive, setQualitySetting } from './mobile.js';
import { bus } from './core/events.js';
import { settings } from './core/settings.js';
import { KEYMAP_HELP, TOUCH_HELP, GAMEPAD_HELP } from './core/actions.js';
import { qualityBudget } from './core/quality.js';
import { createAutosave, createSaveStore, defaultSave, SAVE_VERSION } from './save.js';
import { createEconomy, HOSPITAL_FEE, LOOT_MIN, LOOT_MAX } from './economy.js';
import { createMenu } from './ui/menu.js';
import { createMenuTour } from './ui/menu-tour.js';
import { createMapView } from './ui/map-view.js';
import { createPhone } from './ui/phone.js';
import { canOpenPhone, createPhoneLink } from './ui/phone-link.js';
import { initPhysics, PhysicsWorld } from './physics/world.js';
import { addStaticBox, buildWorldColliders, osmWithBuildings } from './physics/colliders.js';
import { GROUPS, queryGroups, WORLD as G_WORLD, VEHICLE as G_VEHICLE, NPC_CAR as G_NPC_CAR, PEDESTRIAN as G_PED, DEBRIS as G_DEBRIS } from './physics/groups.js';
import { CharacterBody } from './physics/character.js';
import { createContactRouter } from './physics/contacts.js';
import { ACTIVE_RADIUS, createPedestrianBody } from './physics/npc-bodies.js';
import { NPC_WRECK_IMPULSE } from './physics/npc-bodies.js';
import { createWorldStep, createFrameLoop } from './core/loop.js';
import { createWeapons, gunshotListeners, loadWeaponModels, createAmmoPickups, WEAPONS, SLOT_KEYS, isGun } from './weapons/index.js';
import { createGunShop, GUN_SHOP_BEACON } from './shops/gun-shop.js';
import { createSafehouses, SAFEHOUSE_BEACON } from './shops/safehouse.js';
import { makeBatSegment } from './weapons/models.js';
import { createWeaponHud } from './weapons/hud.js';
import { attachWeapon, detachWeapon } from './character-animation.js';
import { createBloodFx } from './blood-fx.js';
import { createAudio } from './audio/index.js';
import { createRadio } from './audio/radio.js';
import { IMPACT_MIN as MISSION_IMPACT_MIN, createMissions, trackMissionStats } from './missions/index.js';
import { NIGHT_MARKET_DELIVERY } from './missions/events.js';
import { applyBeacon } from './missions/garbage-truck.js';
import { camViewSettingKey, camViewsFromSettings, isCamViewKey } from './ui/cam-view-hint.js';
import { buildRoadGraph, createNavigator, findRoute, projectToGraph } from './navigation.js';
import { createBigMap } from './map/big-map.js';
import { createCheckins } from './collect/checkins.js';
import { createFoodGuide } from './collect/food-guide.js';
import { landmarkPoints } from './core/landmark-points.js';
import './wanted/wanted.css';
import { createWanted, CRIMES } from './wanted/wanted.js';
import { createPolice } from './wanted/police.js';
import { createPoliceAdapters } from './wanted/adapters.js';
import { createWantedUI } from './wanted/ui.js';
import { createHelicopter, createHeliObstacleTop } from './wanted/helicopter.js';
import { respawnPlace, SPRAY_SHOPS } from './wanted/places.js';
import { createSprayShops } from './wanted/spray.js';
import { createBeaconPool } from './missions/light-pillar.js';
import { STORES } from './wanted/places.js';
import { createRobberies, aimNear, AIM_HEIGHT, PROGRESS_LABEL } from './wanted/robbery.js';
import { createVigilante, createFugitiveWorld, createVigilanteBar, PROMPT_TEXT as VIG_PROMPT } from './missions/vigilante.js';
import { createRaces, createRivalWorld, createRaceHud, arrowAngle as raceArrowAngle, promptText as racePromptText, CP_RADIUS as RACE_CP_RADIUS } from './missions/race.js';
import { createTaxi, createCurbPedWorld, createSideJobBar, PROMPT_START as TAXI_PROMPT_START, PROMPT_QUIT as TAXI_PROMPT_QUIT } from './missions/taxi.js';
import { createEms, createAmbulanceDepot, ambulanceSpot, PROMPT_START as EMS_PROMPT_START, PROMPT_QUIT as EMS_PROMPT_QUIT } from './missions/ems.js';
import { createGangs, createGangCars, GANG_ZONES } from './gangs.js';
import { createStreetEvents, createStreetWorld } from './street-events.js';
import { createRampage, createRampageWorld, createRampageHud, createSkullMarkers } from './missions/rampage.js';
import { createStunts, createRampMesh, addRampColliders, createStuntHud } from './stunts.js';
import { createPackages, createPackageMesh } from './collect/packages.js';
import { createSnatch, SNATCH_PROMPT } from './snatch.js';
import { createStory, createStoryHud, createStoryCarDepot, CONTACT as STORY_CONTACT, STORY_BEACON, STORY_SKIP_KEY, VAN_TYPE as STORY_VAN_TYPE, VAN_COLOR as STORY_VAN_COLOR } from './missions/story.js';
import { createFirefighter, createFireWorld, createFireTruckDepot, createWaterCannonMesh, nozzleOf, isFireTruck, FIRE_STATION, FIRE_TRUCK_SPOT, FIRE_STATION_BEACON, PROMPT_START as FIRE_PROMPT_START, PROMPT_QUIT as FIRE_PROMPT_QUIT, SPRAY_KEY as FIRE_SPRAY_KEY } from './missions/firefighter.js';

const ENTER_DIST = 2.6; // 上車 / 扶起距離（m，距車身圓）
const SNATCH_PRIORITY = 5; // P19 飛車搶包互動優先序（高於委託 3 / 打卡 2 / 副任務 4：騎機車搶包時蓋過其他提示）
const CARJACK_SCAN = 6; // 搶車候選的搜尋半徑（m，traffic.carjackCandidates；實際門檻由 carjack.canStart 判斷車門距離）
const WASTED_DELAY_SEC = 2; // 玩家 hp 歸零倒地後多久進入送醫（WASTED）流程（Phase 7 取代原地起身）
const BUSTED_FINE = 150; // 被捕罰鍰（NT$，餘額不足扣到 0）
const WASTED_FEE = HOSPITAL_FEE; // 送醫醫藥費（NT$100）：economy 已在 player:ko 扣款，WASTED 不重複扣
const CRIME_GUNFIRE_RANGE = 40; // 玩家開槍時此距離內有行人或警員才算 gunfire（m）
const CRIME_REPORT_RANGE = 35; // 無警力看見時，此距離內有行人才以路人報案（witnessed=false）回報（m）
const POLICE_RAM_MIN_SPEED = 3; // 玩家車撞警車：相對速度達此值、且玩家車比警車快才算 policeVehicle（m/s；警車 ram 玩家不算玩家犯行）
const POLICE_RAM_COOLDOWN = 2; // 同一台警車 policeVehicle 回報的冷卻（s，同一次碰撞的連續接觸只算一次）
const WANTED_HINT_TEXT = '被通緝了！星星代表警方追緝程度，離開警察視線並躲出小地圖的搜索圈就能擺脫。';
const CLERK_SPAWN_DIST = 120; // 超商店員（Phase 9）：玩家距櫃檯此距離內才生成（m）
const CLERK_DESPAWN_DIST = 150; // 超過此距離回收店員（m；與生成距離留遲滯）
const CLERK_COLORS = { shirt: '#2E7D32', pants: '#1B3A1F' }; // 店員綠色系制服（pedestrian 角色執行期換色，不改模型檔）
const CLERK_HP = 100;
const VIG_URGENT_SEC = 30; // 警車任務條剩此秒數內轉紅（.vig-urgent）
const VIG_PRIORITY = 4; // 警車任務互動優先序（高於委託 3：駕駛警車時 E 優先開始警車任務）
const RACE_LOCK_CONTROLS = Object.freeze({ throttle: 0, steer: 0, brake: 1, handbrake: true }); // 倒數鎖車控制（重用，不每幀配置）
const RACE_PRIORITY = 5; // 街頭競速起點互動優先序（高於警車任務 4 / 委託 3：駕車進起點光柱時 E 優先開賽）
const RACE_CP_BEACON = { height: 45, radius: RACE_CP_RADIUS, sink: 2 }; // 競速檢查點大光柱圈（半徑 = 通過判定半徑 12 m；顏色 BEACON_COLORS.race 橘 #fb8c00）
const RACE_SPAWN_PAD = 2.5; // 對手車生成格位離建築輪廓至少（m，buildingAt pad）
const SIDEJOB_PRIORITY = 4; // 計程車 / 救護車互動 sideInter.priority（僅標示；實際仲裁 = 駕駛中 if (!inter) 鏈的最後後備，不經 pickInteractable）
const SIDEJOB_BEACON = { height: 40, radius: 8, sink: 2 }; // 計程車目的地 / 醫院光柱（顏色 BEACON_COLORS.taxi 黃 / ems 紅）
const AMB_FLASH_SEC = 0.25; // 救護車頂燈紅藍交替間隔（s；只改 emissiveIntensity）
const STORE_BEACON = { height: 7, radius: 0.7, sink: 1 }; // 超商門口小光柱（createBeaconPool 選項；顏色 BEACON_COLORS.store 綠 #43a047）
const AUTOSAVE_SEC = 15; // 自動存檔間隔（s）
const MAX_STEP_DIST = 30; // 單幀位移超過此值（傳送 / 重生）不計入里程（m）
const ROAD_NAME_SEC = 0.5; // 駕駛時路名查詢間隔（s）
const CLEANUP_SEC = 2; // 搶來 / 報廢車輛的回收檢查間隔（s）
const ADOPTED_FAR = 200; // 搶來的車（玩家已離開）超過此距離就回收（m）
const WRECK_FAR = 150; // 熄火報廢的車超過此距離就回收（m）
const FPS_SAMPLE_SEC = 0.5; // FPS 顯示更新間隔（s）
const PERF_FRAMES = 120; // __game.perf() 統計的最近幀數
const CRASH_SHAKE_SPEED = 25; // 撞擊相對速度（m/s）達此值時鏡頭震動 trauma = 1
const EXPLOSION_HEAR_RADIUS = 45; // m：爆炸聲驚嚇行人半徑（V4）
const EXPLOSION_DV = 9; // m/s：爆心處剛體的速度變化（依距離線性衰減、依 power 縮放；V4 explosionImpulse）
const EXPLOSION_SPIN = 0.6; // 角衝量比例（翻滾感）
const HINT_ATTACK_SEC = 8; // 步行幾秒後出現「攻擊」提示卡
const HINT_PAUSE_SEC = 30; // 遊玩幾秒後出現「暫停選單」提示卡
const FOG_NEAR_RATIO = 0.25; // 畫質視距縮短時霧的起點（相對霧終點）
const SAVE_POS_SHRINK = 0.85; // 存檔位置重疊查詢用的膠囊半徑比例：存下的位置本來就站得住，留一點誤差避免貼牆點被誤判
const AIM_CANDIDATE_RANGE = 40; // 觸控瞄準輔助的候選行人半徑（m，契約 §13）
const JUNCTION_SCAN_SEC = 0.5; // 音效「最近路口距離」的查詢間隔（s）
const SKID_REF = 8; // 側滑速度（m/s）達此值時 skid01 = 1（附錄 B 音效）
const TRUCK_NEAR_MIN = 150; // 垃圾車路線起點：玩家附近這個距離帶（m）內的道路點（garbage-truck.js routeFor 約定）
const TRUCK_NEAR_MAX = 300;
const TRUCK_FAR_MIN = 250; // 路線終點：沿同方向再往外這麼遠（m）的道路點
const TRUCK_FAR_MAX = 450;
const TRUCK_ROUTE_TRIES = 4; // 每次 routeFor 最多試幾個方向（都失敗 → 回 null，garbage-truck.js 隔 2 s 再問）
const TRUCK_MIN_ROUTE_M = 100; // 太短的路線不用（垃圾車在折線上 ping-pong）
const STALL_CURB_GAP = 1.2; // 夜市攤車離路緣（m）
const STALL_WALL_GAP = 3; // 夜市攤車離建築外牆至少（m）
const STALL_CLEAR_SCAN = 20; // 攤車兩側比較離牆距離時的掃描上限（m）
const VALET_CLEAR_M = 4; // 代客泊車接單時，清掉上一趟留在客人車位 / 車格這個半徑內的泊車車（m）
const VALET_CAR_LOOKS = [ // 代客泊車的客人車（不含機車 / 大車：車格判定以轎車尺寸設計）
  { type: 'sedan', color: '#1d1f24' },
  { type: 'sedan', color: '#e9e9ea' },
  { type: 'suv', color: '#5b6470' },
  { type: 'sedan', color: '#8c1c24' },
];
const BASE_URL = import.meta.env.BASE_URL ?? './';
const WEATHER_PREFS = ['auto', ...WEATHER_KINDS]; // 設定 weather 的合法值（'auto' = 自動切換）

// ---------- 純函式（tools/test/integration-p3.mjs 會擷取本區塊在 node 驗證；不可引用模組內其他識別字）----------
// @integration-p3:pure-begin
// HUD 底部常駐按鍵提示：由 KEYMAP_HELP / TOUCH_HELP（help）依模式取子集，不寫死按鍵文字
const CONTROLS_HINT = {
  walk: [['步行', 'attack'], ['步行', 'enterExit'], ['步行', 'sprint'], ['通用', 'map'], ['通用', 'pause'], ['通用', 'phone']],
  drive: [['駕駛', 'horn'], ['駕駛', 'lookBack'], ['駕駛', 'enterExit'], ['通用', 'camera'], ['通用', 'pause']],
};
function helpItem(help, action, group = null) {
  for (const g of help) {
    if (group && g.group !== group) continue;
    for (const it of g.items) if (it.action === action) return it;
  }
  return null;
}
function controlsHintItems(help, mode) {
  const out = [];
  for (const [group, action] of CONTROLS_HINT[mode] || []) {
    const it = helpItem(help, action, group);
    if (it) out.push({ keys: it.keys, desc: it.desc });
  }
  return out;
}
// 新手提示卡文字（id → 說明表的動作）；找不到說明列回 null（不顯示）
const HINT_ACTIONS = { move: ['步行', 'move'], attack: ['步行', 'attack'], enter: ['步行', 'enterExit'], pause: ['通用', 'pause'] };
function hintText(help, id) {
  const a = HINT_ACTIONS[id];
  const it = a && helpItem(help, a[1], a[0]);
  return it ? `${it.keys}：${it.desc}` : null;
}
// 存檔位置是否可用：有限數、在地圖範圍內、不在實體建築碰撞體內、不在水中
//   deps = { solidAt?, buildingAt, inWater, inBounds }：solidAt(x, z) 為真 = 角色膠囊放在該點會與建築碰撞體重疊（物理查詢）；
//   沒給 solidAt 時退回 buildingAt(x, z, 0)（點在輪廓內才算）。騎樓 / 遮簷下這類貼著外牆、玩家走得到的點不可判為建築內
function validSavedPosition(p, deps) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  if (deps.inBounds && !deps.inBounds(p.x, p.z, 5)) return false;
  if (deps.solidAt ? deps.solidAt(p.x, p.z) : deps.buildingAt(p.x, p.z, 0)) return false;
  if (deps.inWater(p.x, p.z, 0.5)) return false;
  return true;
}
// 最近 n 筆數值的平均與 p95（ms）
function perfStats(buf, n) {
  if (!n) return { avg: 0, p95: 0 };
  const a = Array.from(buf.slice(0, n)).sort((x, y) => x - y);
  let sum = 0;
  for (const v of a) sum += v;
  return { avg: sum / n, p95: a[Math.min(n - 1, Math.floor(n * 0.95))] };
}
// interactable 仲裁（契約 §17）：priority 高者優先（任務 3 > 打卡 2 > 小吃 1 > 彈藥 0），同級取 dist 近者；null 項略過；都沒有回 null
function pickInteractable(list) {
  let best = null;
  let bp = -Infinity;
  let bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    const p = Number.isFinite(it.priority) ? it.priority : 0;
    const d = Number.isFinite(it.dist) ? it.dist : Infinity;
    if (p > bp || (p === bp && d < bd)) {
      best = it;
      bp = p;
      bd = d;
    }
  }
  return best;
}
// 存檔統計 = 經濟統計 + 整合層自行累加的欄位（missionsDone / missionsFailed / shotsFired 為本局累計值；
//   pedsKnockedOut 另加 bat / bullet 擊倒數，economy 只算 punch）
function statsWithExtra(stats, extra) {
  return {
    ...stats,
    missionsDone: extra.missionsDone,
    missionsFailed: extra.missionsFailed,
    shotsFired: extra.shotsFired,
    pedsKnockedOut: (stats.pedsKnockedOut || 0) + extra.pedsKnockedOut,
  };
}
// 把 +Y 轉到 (dx, dy, dz) 方向的單位四元數（Rapier 膠囊沿本地 Y）；零向量 → 單位四元數；寫入 out（不配置）
function capsuleRotation(dx, dy, dz, out) {
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-9) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  const ux = dx / l;
  const uy = dy / l;
  const uz = dz / l;
  if (uy < -1 + 1e-9) {
    out.x = 1;
    out.y = 0;
    out.z = 0;
    out.w = 0;
    return out;
  }
  // q = (Y × u, 1 + Y·u) 正規化；Y × u = (uz, 0, −ux)
  const w = 1 + uy;
  const n = Math.hypot(uz, ux, w);
  out.x = uz / n;
  out.y = 0;
  out.z = -ux / n;
  out.w = w / n;
  return out;
}
// @integration-p3:pure-end

// 耐久扣值 → 等效撞擊速度（impactDamage 的反函數，以 static 係數估；撞行人係數 0.2 會得到較低速度，偏保守）
// vehicle:damaged 的 delta 是去重後「多出的部分」，反推值只會偏低，交給委託的合併視窗取最大值
function impactSpeedFromDamage(vehicle, delta) {
  const k = impactDamage(vehicle, DAMAGE_MIN_SPEED + 1, 'static'); // = K × 質量係數（relSpeed − 4 = 1）
  if (!(k > 0) || !(delta > 0)) return 0;
  return DAMAGE_MIN_SPEED + Math.pow(delta / k, 1 / DAMAGE_EXP);
}

// V5 路障路錐（policeAdapters.createCone；最多 MAX_CONES 個由 adapters 池化重用）：橘色圓錐 + 白色反光環，幾何 / 材質全部共用
let roadConeParts = null;
function createRoadCone() {
  if (!roadConeParts) {
    roadConeParts = {
      cone: new THREE.ConeGeometry(0.22, 0.75, 10).translate(0, 0.375, 0),
      band: new THREE.CylinderGeometry(0.15, 0.17, 0.12, 10).translate(0, 0.42, 0),
      base: new THREE.BoxGeometry(0.5, 0.05, 0.5).translate(0, 0.025, 0),
      orange: new THREE.MeshStandardMaterial({ color: 0xff5a10, roughness: 0.6 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, emissive: 0x444444, roughness: 0.4 }),
    };
  }
  const p = roadConeParts;
  const g = new THREE.Group();
  g.name = 'police-cone';
  g.add(new THREE.Mesh(p.base, p.orange), new THREE.Mesh(p.cone, p.orange), new THREE.Mesh(p.band, p.white));
  return g;
}

// V4 爆炸物理衝量（explosions.js 的 physics.radialImpulse）：球形查詢半徑內的車（停放車先轉 dynamic）/ 車流車（轉 wrecked）/ 動態雜物，
//   依距離給速度變化（Δv = EXPLOSION_DV × 衰減 × power / 140，與質量無關）+ 少量翻滾；行人剛體由 combat 擊倒流程處理，這裡不碰
// 查詢期間只收集 collider，結束後才改剛體型別 / 施力；每次爆炸配置一個 Set（事件層級，非每幀）
function createExplosionImpulse({ RAPIER, pw, router, groups, flags }) {
  const ball = new RAPIER.Ball(1);
  const pos = { x: 0, y: 0, z: 0 };
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  const query = { flags, groups };
  const found = [];
  const collect = (c) => {
    found.push(c);
    return true;
  };
  const imp = { x: 0, y: 0, z: 0 };
  const spin = { x: 0, y: 0, z: 0 };
  const UP = { x: 0, y: 1, z: 0 };
  return {
    radialImpulse(x, y, z, radius, power) {
      found.length = 0;
      ball.radius = Math.max(0.5, radius);
      pos.x = x;
      pos.y = y;
      pos.z = z;
      pw.intersections(pos, rot, ball, collect, query);
      const seen = new Set();
      for (const c of found) {
        const ent = router.entityOf(c.handle);
        let body = null;
        if (ent && ent.kind === 'vehicle') {
          if (!ent.active) continue;
          if (ent.kinematic) {
            ent.setKinematic(false);
            if (ent.owner) ent.owner.rest = 0;
          }
          body = ent.body;
        } else if (ent && ent.kind === 'npcCar') {
          if (!ent.active) continue;
          if (!ent.isWrecked) ent.hit({ impulse: NPC_WRECK_IMPULSE, dir: UP });
          if (!ent.isWrecked) continue;
          body = ent.body;
        } else if (!ent || ent.kind === 'world') {
          body = c.parent();
          if (!body || !body.isDynamic()) continue;
        } else continue;
        if (!body || seen.has(body.handle)) continue;
        seen.add(body.handle);
        const t = body.translation();
        const dx = t.x - x;
        const dz = t.z - z;
        const d = Math.hypot(dx, t.y - y, dz);
        const k = Math.max(0, 1 - d / radius);
        if (k <= 0) continue;
        const hd = Math.hypot(dx, dz) || 1;
        const J = body.mass() * EXPLOSION_DV * k * (power / 140);
        imp.x = (dx / hd) * J;
        imp.y = J * 0.8;
        imp.z = (dz / hd) * J;
        body.applyImpulse(imp, true);
        spin.x = (dz / hd) * J * EXPLOSION_SPIN;
        spin.y = 0;
        spin.z = (-dx / hd) * J * EXPLOSION_SPIN;
        body.applyTorqueImpulse(spin, true);
      }
    },
  };
}

// 老虎城玻璃等材質的反射環境：scene.environment 已有就沿用；否則以 PMREM 從簡單天空漸層場景產生一張
//   只給材質 envMap 用，不設成 scene.environment（避免改變全場景光照）；產生後 dispose generator 與暫時場景
function landmarkEnvMap(renderer, scene) {
  if (scene.environment) return scene.environment;
  const sky = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color(0x6f9fd8);
  const horizon = new THREE.Color(0xdfe8f0);
  const ground = new THREE.Color(0x55524c);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 10; // -1（正下方）～ 1（天頂）
    if (h >= 0) c.copy(horizon).lerp(zenith, Math.pow(h, 0.6));
    else c.copy(horizon).lerp(ground, Math.min(1, -h * 3));
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  sky.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(sky, 0.04).texture;
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return envMap;
}

// JSON 讀取（地標 / 委託 / 小吃 manifest 共用）：404、非 JSON（dev server 回退成 index.html）、網路錯誤 → null，不丟例外
async function fetchJson(url) {
  try {
    const res = await fetch(/^(\w+:|\/)/.test(url) ? url : BASE_URL + url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const text = await res.text();
    if (/^\s*</.test(text)) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// 垃圾車路線（missions routeFor）：p = 玩家位置（garbage-truck.js 尚未拿到位置時為 null → 呼叫端代入 focus）；
// 隨機方向取 TRUCK_NEAR_MIN–MAX 公尺外的點投影到路網（起點），同方向 ±45° 再往外 TRUCK_FAR_MIN–MAX 公尺投影（終點），findRoute 折線；
// 起點離玩家太近 / 太遠（投影跑掉）或路線過短 → 換方向重試；全部失敗回 null
function garbageTruckRoute(graph, p, rng) {
  if (!graph || !p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  for (let i = 0; i < TRUCK_ROUTE_TRIES; i++) {
    const a = rng() * Math.PI * 2;
    const r = TRUCK_NEAR_MIN + rng() * (TRUCK_NEAR_MAX - TRUCK_NEAR_MIN);
    const near = projectToGraph(graph, p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, {});
    if (!near) continue;
    const dn = Math.hypot(near.x - p.x, near.z - p.z);
    if (dn < TRUCK_NEAR_MIN * 0.5 || dn > TRUCK_NEAR_MAX * 1.5) continue;
    const b = a + (rng() - 0.5) * (Math.PI / 2);
    const rf = r + TRUCK_FAR_MIN + rng() * (TRUCK_FAR_MAX - TRUCK_FAR_MIN);
    const far = projectToGraph(graph, p.x + Math.sin(b) * rf, p.z + Math.cos(b) * rf, {});
    if (!far) continue;
    const route = findRoute(graph, near, far);
    if (route && route.points && route.points.length >= 2 && route.lengthM >= TRUCK_MIN_ROUTE_M) return route.points;
  }
  return null;
}

// 最近的地面車道中心線點：{ x, z, hw（半寬）} 或 null（啟動時呼叫一次，逐段掃描）
function nearestRoadPoint(px, pz) {
  let best = null;
  let bestD = Infinity;
  for (const r of surfaceRoads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 1e-12 ? ((px - a.x) * dx + (pz - a.z) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, z, hw: r.hw, dx, dz };
      }
    }
  }
  return best;
}

// 夜市攤車擺位：取餐點（惠來路二段西側路緣外的無影空地，events.js pickup）最近的車道 → 垂直方向路緣外 STALL_CURB_GAP + 半個攤車深的兩側候選點
// 合格 = 不在車道上、不在步道（footway）上（不擋人行動線）、離建築外牆 ≥ STALL_WALL_GAP；合格者取離牆較遠的一側
// （避開貼著商場外牆的牆面陰影）；都不合格退回第一側。正面（+Z）朝向該道路點；回傳 placeProp 的 opts（y 由呼叫端取地面高）
function stallPlacement(pickup, depth) {
  const road = nearestRoadPoint(pickup.x, pickup.z);
  if (!road) return { x: pickup.x, z: pickup.z, yaw: 0 };
  const len = Math.hypot(road.dx, road.dz) || 1;
  const nx = -road.dz / len;
  const nz = road.dx / len;
  const off = road.hw + STALL_CURB_GAP + depth / 2;
  // 離最近建築外牆的距離（1 m 解析度，上限 STALL_CLEAR_SCAN）
  const clearance = (x, z) => {
    for (let p = 0; p < STALL_CLEAR_SCAN; p++) if (buildingAt(x, z, p)) return p;
    return STALL_CLEAR_SCAN;
  };
  let pick = null;
  let best = -1;
  for (const s of [1, -1]) {
    const x = road.x + nx * off * s;
    const z = road.z + nz * off * s;
    if (!pick) pick = { x, z };
    if (onRoadSurface(x, z, 0.3, false) || onRoadSurface(x, z, depth / 2, true)) continue;
    const c = clearance(x, z);
    if (c >= STALL_WALL_GAP && c > best) {
      best = c;
      pick = { x, z };
    }
  }
  return { x: pick.x, z: pick.z, faceX: road.x, faceZ: road.z };
}

// 夜間發光登記（daynight registerNight）；同一共用材質只登記一次（與 vehicle.js registerModelNight 同上限：glb 原 emissiveIntensity）
// 名稱含 beacon 的材質（垃圾車警示燈）不登記：亮度由 syncGarbageTruck 每幀 applyBeacon 設定，登記了會被 daynight 每幀覆寫（§23.5）
function registerNightOnce(m) {
  if (!m || (typeof m.name === 'string' && m.name.includes('beacon')) || nightMaterials.some((e) => e.material === m)) return;
  registerNight(m, m.emissiveIntensity || 1);
}

const loading = new LoadingScreen(TRIVIA);

async function init() {
  const total = 14;
  let step = 0;
  const progress = async (text) => {
    step++;
    loading.setProgress(step / total, text);
    await nextFrame();
  };

  // 畫質：設定值（auto / 各級）→ tier → 預算（人車數、分層半徑、視距、陰影、DPR 上限）
  setQualitySetting(settings.get('quality'));
  let tier = qualityTier();
  let budget = qualityBudget(tier);
  const touch = isTouch();

  await progress('建立渲染器…');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.getElementById('app').appendChild(renderer.domElement);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, budget.viewDist);
  const dayNight = new DayNight(scene, defaultSave().world.hour);
  // 環境（Phase 5）：attach dayNight 後天空 / 霧 / 光由 environment 合成天氣後套用；霧距 = 視距夾過的基準 × 天氣倍率
  const env = createEnvironment({ scene, dayNight, viewDist: budget.viewDist, fogNearRatio: FOG_NEAR_RATIO });
  // 天氣：設定 weather（auto / clear / rain / fog，core/settings schema 已有此鍵）；選單另經 bus 'weather:setting' 傳入時同樣套用（見 ui/menu.js）
  const readWeatherPref = () => {
    const v = settings.get('weather');
    return WEATHER_PREFS.includes(v) ? v : 'auto';
  };
  let weatherPref = readWeatherPref();
  const weather = createWeather({ scene, camera, quality: budget, THREE, auto: weatherPref === 'auto', initial: weatherPref === 'auto' ? 'clear' : weatherPref });
  const applyWeatherPref = (v) => {
    const pref = WEATHER_PREFS.includes(v) ? v : 'auto';
    if (pref === weatherPref) return;
    weatherPref = pref;
    weather.setAuto(pref === 'auto');
    if (pref !== 'auto') weather.setWeather(pref, { instant: true }); // 多半在暫停選單內切換：立即到位，回遊戲即看到
  };
  // 視距：鏡頭 far = budget.viewDist；霧距交給 environment（霧終點不超過視距，遠處不會被 far 平面硬切）
  const applyViewDist = (dist) => {
    camera.far = dist;
    camera.updateProjectionMatrix();
    env.setViewDist(dist);
  };
  applyViewDist(budget.viewDist);
  // 每幀環境：順序固定 dayNight.update（呼叫端先做）→ weather.update（遊戲時鐘吃 simDt，暫停 / 面板開啟時 0）→ env.update
  const updateEnvironment = (dt, simDt) => {
    weather.update(dt, simDt);
    env.update(dt, { dayNight, weather });
  };
  // 效能分級：需在光源建立後呼叫，低品質時才能調降 / 關閉陰影貼圖
  applyRendererQuality(renderer, 1, scene, tier);
  let adapt = createAdaptiveResolution(renderer, tier);
  let adaptive = tier === 'low'; // 自適應解析度只在低品質（手機）啟用
  // 選擇性泛光（v1b-bloom）：low 不建 composer、mid 半解析度、high / ultra 全解析度；白天強度 0 時直接 renderer.render
  const postfx = createPostFx(renderer, scene, camera, { tier, THREE, passes: await loadPostFxPasses(), night: () => dayNight.night });
  const terrain = getTerrain();

  await progress('依 OSM 鋪設道路、公園與水域…');
  const world = buildWorld(scene, { anisotropy });
  const qiuhonggu = buildQiuhonggu(terrain, { footways: surfaceFootways });
  scene.add(qiuhonggu.group);

  await progress('載入地標模型…');
  const envMap = landmarkEnvMap(renderer, scene);
  const landmarks = await loadLandmarkModels((done, n, name) => {
    loading.setProgress((step + done / n) / total, `載入地標模型 ${done}/${n}：${name}`);
  }, { envMap });
  // 地標點（任務 / 打卡 / 大地圖共用，契約 §17）：manifest 缺檔 → []
  const landmarkPts = landmarkPoints((await fetchJson('models/manifest.json')) ?? [], projectLatLon);

  await progress('載入角色與車輛模型…');
  const propModels = (await Promise.all([loadCharacterModels(), loadVehicleModels(), loadPropModels()]))[2];
  const hasProp = (k) => propModels.has(k); // 道具鍵名（manifest id）的 glb 是否載入成功
  // 夜市攤位（prop-model.js + job-props.js stallRow）：原攤車 night_market_stall 在原位（夜市外送取餐點旁、離牆較遠的路側，正面朝道路），
  //   變體 night_market_stall_oyster / night_market_stall_tea 沿路緣左右各一格（STALL_ROW_PITCH）混擺；變體缺模型 → 退回原攤車、原攤車也缺 → 該格不擺
  //   （外送 / 打工照常，座標仍由 stallRow 算出）；碰撞盒一律 propColliderBox('night_market_stall', pl)（§23.1 定值，變體車架相同），物理世界建好後補靜態碰撞體
  //   各畫質（含 low）都擺；夜市跑單接單攤 = oyster 那一格（runStallSpot），檯面擺 takeout_bag（開放接單時顯示，缺模型不擺）
  const stallSlots = stallRow(stallPlacement(NIGHT_MARKET_DELIVERY.pickup, propInfo(STALL_BASE_KEY)?.depth ?? 1.56), heightAt, hasProp);
  const stalls = [];
  const stallBoxes = [];
  for (const s of stallSlots) {
    if (!s.model) continue;
    const obj = createPropModel(s.model);
    placeProp(obj, { x: s.pl.x, z: s.pl.z, y: s.pl.y, yaw: s.pl.yaw });
    scene.add(obj);
    s.obj = obj;
    stalls.push(obj);
    stallBoxes.push(s.box);
    for (const m of propEmissiveMaterials(s.model)) registerNightOnce(m);
  }
  const stall = stalls[0] || null; // 原攤車那一格（__game 除錯用）
  const runStall = runStallSpot(stallSlots);
  const runStallObj = runStall.entry.obj || null;
  const takeoutBags = [];
  if (runStallObj && hasProp(TAKEOUT_BAG_KEY)) {
    for (const p of TAKEOUT_BAG_LOCAL) {
      const bag = createPropModel(TAKEOUT_BAG_KEY);
      bag.position.set(p[0], p[1], p[2]);
      bag.visible = false;
      runStallObj.add(bag);
      takeoutBags.push(bag);
    }
  }
  // 代客泊車亭（job-props.js VALET_SITES；座標見 §24.2）：valet_stand 缺模型 → 程式幾何；碰撞只取亭身（valetStandBoxes，不擋亭與立牌間空隙）
  const valetSites = valetSpots(VALET_SITES, heightAt, propInfo(VALET_STAND_KEY)?.counter);
  const valetBoxes = [];
  for (const s of valetSites) {
    const obj = hasProp(VALET_STAND_KEY) ? createPropModel(VALET_STAND_KEY) : buildValetStandFallback(THREE);
    placeProp(obj, { x: s.pl.x, z: s.pl.z, y: s.pl.y, yaw: s.pl.yaw });
    scene.add(obj);
    valetBoxes.push(...valetStandBoxes(s.pl));
  }
  if (hasProp(VALET_STAND_KEY)) for (const m of propEmissiveMaterials(VALET_STAND_KEY)) registerNightOnce(m);

  await progress('依 OSM 輪廓擠出七期建築…');
  const buildings = buildBuildings(scene, { anisotropy, landmarks });

  await progress('計算出生點…');
  const spawn = computeSpawn();

  await progress('初始化物理引擎…');
  const RAPIER = await initPhysics();
  const pw = new PhysicsWorld(RAPIER);
  // 必須在 buildQiuhonggu / buildBuildings 之後：木平台等 addWalkable 追加的可行走面才會一併建成碰撞體
  const colliderStats = buildWorldColliders(RAPIER, pw.world, { osm: osmWithBuildings(osm, buildings.colliders), terrain });
  for (const b of [...stallBoxes, ...valetBoxes]) addStaticBox(RAPIER, pw.world, b); // 夜市攤位 / 泊車亭：WORLD 組靜態方塊（各畫質皆有）
  const router = createContactRouter(RAPIER, pw);
  pw.onAfterStep((dt) => router.drain(dt));
  const physics = { RAPIER, pw, router, groups: GROUPS };
  pw.stepOnce(); // 更新 broad phase，第一幀之前的查詢（下車點、鏡頭掃掠）就看得到世界碰撞體

  // ---------- 遊戲狀態 ----------
  const state = {
    started: false, // 遊戲進行中（false = 開始畫面的背景環繞）
    paused: false, // 暫停選單開啟中：世界停止更新、照常渲染
    mode: 'walk', // 'walk' | 'entering'（上車動作中）| 'carjack'（搶車中）| 'drive'
    vehicle: null,
    placeId: null,
    koTimer: 0, // 玩家 hp 歸零倒地後到送醫（WASTED）的倒數（秒）
    respawn: null, // 被捕 / 送醫流程進行中：'busted' | 'wasted' | null（輸入鎖定、玩家不受攻擊）
    spraying: null, // 噴漆廠進行中：shopId | null（輸入鎖定；與 respawn 互斥，期間不觸發 BUSTED / WASTED）
    pendingFall: null, // 物理子步內機車倒地（vehicles.onFall），step 結束後才處理下車
    walkTime: 0, // 本局步行累計秒數（新手提示用）
    playTime: 0, // 本局遊玩秒數（新手提示用）
  };
  const focus = new THREE.Vector3();

  await progress('停放車輛與號誌…');
  const parked = computeParkedVehicles(spawn);
  const vehicles = new VehicleManager(scene, parked, terrain, physics, { bus, roads: surfaceRoads }); // 掉出世界時重置到最近道路
  // 熄火黑煙夜間提亮：dayNight.night（0–1）
  const dmg = createVehicleDamage({ bus, THREE, scene, isNight: () => dayNight.night });
  for (const v of vehicles.vehicles) dmg.attach(v);
  pw.onAfterStep((h) => dmg.step(h)); // 去重時鐘 = 模擬時間；在 router.drain 之後（同一子步的撞擊看到的是推進前的時刻）
  const adopted = new Set(); // 搶車 adopt 出來的車（玩家離開後遠了就回收）
  const lights = createTrafficLights();
  lights.buildMeshes(scene, { heightAt });
  pw.onBeforeStep((h) => lights.step(h)); // 相位 = 模擬時間；須在 new Traffic 之前登記（同一子步車流讀到本子步時刻）

  // 對抗計時用遊戲時鐘（暫停 / 切背景時不前進）；玩家駕駛的車撞人 → 駕駛 = 玩家（byPlayer）
  let gameTime = 0;
  const combat = new CombatSystem({
    now: () => gameTime,
    vehicleDriver: (ref) => (state.mode === 'drive' && ref && state.vehicle && ref.body === state.vehicle.body ? player.actor : null),
  });

  await progress('放出行人與車流…');
  // V2 幫派地盤（src/gangs.js）：須在 Traffic 之前建立，開場補滿的市民就會依地盤換成幫派成員（pedHooks）
  const gangs = createGangs({ bus, rng: Math.random });
  const traffic = new Traffic(scene, { center: spawn, terrain, physics, combat, budget, lights, bus, gangs: gangs.pedHooks });

  await progress('準備角色與鏡頭…');
  const player = new Player(scene, spawn);
  // 膠囊依主角身高（manifest height）換算，半徑維持 PLAYER_RADIUS
  const character = new CharacterBody(RAPIER, pw, { x: spawn.x, y: spawn.y, z: spawn.z, radius: PLAYER_RADIUS, halfHeight: player.capsuleHalfHeight });
  player.attachPhysics(character);
  player.attachCombat(combat);
  player.placeAt(spawn.x, spawn.z, spawn.yaw, terrain);
  const input = new Input(renderer.domElement);
  input.setSensitivity({ mouse: settings.get('lookSensMouse'), touch: settings.get('lookSensTouch'), pad: settings.get('lookSensPad') });
  input.setInvertY(settings.get('invertY'));
  const occluder = new PhysicsOccluder(pw, colliderStats);
  const rig = new CameraRig(camera, occluder, terrain);
  rig.yaw = spawn.yaw;
  rig.playerHeight = player.height; // 步行目標點依主角身高
  rig.setViews(camViewsFromSettings(settings)); // 鏡頭段位（§23.2：camWalkView / camDriveView，缺鍵 = 預設中段）

  await progress('繪製小地圖…');
  const hud = new HUD();
  const help = touch ? TOUCH_HELP : KEYMAP_HELP;

  await progress('準備武器、委託與導航…');
  // ---------- 武器（W1）：raycast / sweep = PhysicsWorld 查詢 + contacts router 的 collider → actor 對照 ----------
  const QF_NO_SENSOR = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  const shotGroups = queryGroups(G_WORLD | G_VEHICLE | G_NPC_CAR | G_PED | G_DEBRIS); // 子彈：世界 / 車 / 行人（不含玩家膠囊與感測區）
  const pedGroups = queryGroups(G_PED); // 球棒掃掠：只看行人
  const entityOfCollider = (c) => (c ? router.entityOf(c.handle) : null);
  const actorOfCollider = (c) => {
    const ent = entityOfCollider(c);
    return ent && ent.kind === 'pedestrian' && ent.owner && ent.owner.actor ? ent.owner.actor : null;
  };
  // 射線：槍口射線排除玩家自己的膠囊；回傳物件重用（weapons / aim.js 讀完即用，不長期持有）
  const rayHit = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, actor: null, surface: 'world', vehicle: null };
  // V4 槍擊車輛：車身 collider → Vehicle（停放 / 玩家車 = VehicleBody.owner；車流車 = traffic.cars 的 car.v，只在命中時線性查找）
  const vehicleOfEntity = (ent) => {
    if (!ent) return null;
    if (ent.kind === 'vehicle') return ent.owner || null;
    if (ent.kind === 'npcCar') for (const c of traffic.cars) if (c.body === ent) return c.v;
    return null;
  };
  const rayQuery = { flags: QF_NO_SENSOR, groups: shotGroups, excludeCollider: undefined };
  const raycast = (origin, dir, maxDist, opts) => {
    const self = opts && opts.excludeActor === player.actor;
    rayQuery.excludeCollider = self && character.enabled ? character.collider : undefined;
    let h = null;
    try {
      h = pw.castRay(origin, dir, maxDist, rayQuery);
    } catch (err) {
      h = null;
    }
    if (!h) return null;
    const ent = entityOfCollider(h.collider);
    const actor = actorOfCollider(h.collider);
    rayHit.point.x = h.x;
    rayHit.point.y = h.y;
    rayHit.point.z = h.z;
    rayHit.normal.x = h.nx;
    rayHit.normal.y = h.ny;
    rayHit.normal.z = h.nz;
    rayHit.actor = actor && !(opts && opts.excludeActor === actor) ? actor : null;
    rayHit.surface = ent && (ent.kind === 'vehicle' || ent.kind === 'npcCar') ? 'vehicle' : 'world';
    rayHit.vehicle = rayHit.surface === 'vehicle' ? vehicleOfEntity(ent) : null;
    return rayHit;
  };
  // 膠囊掃掠：from–to 為軸（半長 = |to − from| / 2、半徑 r），與行人剛體重疊者 → actor 陣列（重用）
  const sweepShape = new RAPIER.Capsule(0.1, 0.1);
  const sweepPos = { x: 0, y: 0, z: 0 };
  const sweepRot = { x: 0, y: 0, z: 0, w: 1 };
  const sweepOut = [];
  const sweepQuery = { flags: QF_NO_SENSOR, groups: pedGroups };
  let sweepExclude = null;
  const sweepHit = (c) => {
    const a = actorOfCollider(c);
    if (a && a !== sweepExclude && sweepOut.indexOf(a) < 0) sweepOut.push(a);
    return true;
  };
  const sweep = (from, to, radius, opts) => {
    sweepOut.length = 0;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    sweepShape.halfHeight = Math.max(1e-3, Math.hypot(dx, dy, dz) / 2);
    sweepShape.radius = Math.max(1e-3, radius);
    sweepPos.x = (from.x + to.x) / 2;
    sweepPos.y = (from.y + to.y) / 2;
    sweepPos.z = (from.z + to.z) / 2;
    capsuleRotation(dx, dy, dz, sweepRot);
    sweepExclude = (opts && opts.excludeActor) || null;
    try {
      pw.intersections(sweepPos, sweepRot, sweepShape, sweepHit, sweepQuery);
    } catch (err) {
      sweepOut.length = 0;
    }
    return sweepOut;
  };
  const recoilSetting = () => {
    const v = settings.get('recoil');
    return Number.isFinite(v) ? v : 1;
  };
  let weaponModels = null; // loadWeaponModels 完成後 { bat, pistol }
  let batSegment = null; // 球棒模型掛上後的實際棒身世界座標（makeBatSegment）；沒有時 weapons 用程序揮擊弧
  const weapons = createWeapons({
    bus,
    combat,
    player,
    settings,
    now: () => gameTime,
    isTouch: touch,
    manifest: getCharacterManifest(),
    raycast,
    sweep,
    // 動畫注入：player.weaponLayer.play；開槍另疊 settings.recoil 強度的加法後座
    playAnim: (name) => {
      if (name === 'pistol_fire') player.weaponLayer.addRecoil(recoilSetting());
      if (name !== 'weapon_equip') return player.weaponLayer.play(name);
      equipStarting = true; // 重播 weapon_equip 會先 cancel 上一段：這個 cancel 不算換手
      const dur = player.weaponLayer.play(name);
      equipStarting = false;
      if (!(dur > 0)) finishWeaponSwap(); // 換裝動作沒播（缺 clip / 全身狀態擋下）→ 立即換模型
      return dur;
    },
    getBatSegment: (grip, tip) => (batSegment ? batSegment(grip, tip) : false),
  });
  // 武器模型掛到主角 weapon_socket（缺則右手骨）；空手拿下；駕駛中隱藏
  let swapPending = false; // weapon:equip 已發、模型還沒換（等 weapon_equip 的換手點）
  let equipStarting = false;
  const applyWeaponModel = () => {
    swapPending = false;
    if (!weaponModels) return;
    const id = weapons.current;
    const m = id === 'fist' ? null : weaponModels[id] || null; // 球棒 / 手槍 / 衝鋒槍 / 散彈槍
    if (!m) {
      detachWeapon(player.character);
      return;
    }
    if (player.character.weapon !== m.object) {
      attachWeapon(player.character, m.object, { gripOffset: m.grip.toArray(), rotation: m.socketQuaternion.toArray() });
    }
    m.object.visible = state.mode !== 'drive';
  };
  loadWeaponModels()
    .then((m) => {
      weaponModels = m;
      batSegment = makeBatSegment(m.bat);
      applyWeaponModel();
    })
    .catch(() => {});
  // 換裝時機：select 發 weapon:equip（state 'equipping'）後播 weapon_equip，到換手點（layer 'swap'）才換模型；
  // 讀檔 restore 發 weapon:equip 時 state 已是 'idle' → 立即換。模型一律依 weapons.current，快速連按最後必停在目前武器
  const finishWeaponSwap = () => {
    if (swapPending) applyWeaponModel();
  };
  bus.on('weapon:equip', () => {
    swapPending = true;
    if (weapons.state !== 'equipping') applyWeaponModel();
  });
  player.weaponLayer.on('swap', finishWeaponSwap);
  // 保底：換手點前動作播完或被打斷（受擊 / 上車 / 開槍）→ 立即換
  const equipEnded = (name) => {
    if (name === 'weapon_equip' && !equipStarting) finishWeaponSwap();
  };
  player.weaponLayer.on('finished', equipEnded);
  player.weaponLayer.on('cancel', equipEnded);
  // 持武器姿勢：球棒 bat_hold、手槍 pistol_hold / 瞄準 pistol_aim（clip 缺 → 退回 hold / 不疊加）；
  // 衝鋒槍 / 散彈槍（雙手）：角色沒有雙手持握 clip → 一律以 pistol_aim（雙臂前伸）近似，左手扶握點 manifest offHandOffset 保留供日後 IK
  let weaponPose = null;
  const updateWeaponPose = (aiming) => {
    const id = weapons.current;
    const want = id === 'bat' ? 'bat_hold' : id === 'pistol' ? (aiming ? 'pistol_aim' : 'pistol_hold') : isGun(id) ? 'pistol_aim' : 'none';
    if (want === weaponPose) return;
    weaponPose = want;
    if (!player.weaponLayer.setPose(want)) player.weaponLayer.setPose(want === 'pistol_aim' ? 'pistol_hold' : 'none');
  };
  // 瞄準資料（每幀重用）：鏡頭中心射線、槍口世界座標（模型掛上時）、觸控吸附候選（40 m 內骨架行人）
  const aim = { origin: camera.position, dir: new THREE.Vector3(0, 0, 1), aiming: false, muzzle: null, candidates: null };
  const muzzleW = new THREE.Vector3();
  const aimCandidates = [];
  const muzzleWorld = () => {
    const m = weaponModels && isGun(weapons.current) ? weaponModels[weapons.current] : null;
    if (!m || !m.muzzle || !m.object.parent || !m.object.visible) return null;
    m.object.updateWorldMatrix(true, false);
    return muzzleW.copy(m.muzzle).applyMatrix4(m.object.matrixWorld);
  };
  const fillAim = (aimHeld) => {
    const pistol = isGun(weapons.current); // 槍械（手槍 / 衝鋒槍 / 散彈槍）
    camera.getWorldDirection(aim.dir);
    aim.aiming = !!aimHeld && pistol;
    aim.muzzle = pistol ? muzzleWorld() : null;
    aim.candidates = null;
    if (!touch || !pistol) return aim;
    aimCandidates.length = 0;
    const r2 = AIM_CANDIDATE_RANGE * AIM_CANDIDATE_RANGE;
    for (const p of traffic.peds) {
      const a = p.actor;
      if (!a) continue;
      const dx = a.pos.x - player.pos.x;
      const dz = a.pos.z - player.pos.z;
      if (dx * dx + dz * dz <= r2) aimCandidates.push(a);
    }
    aim.candidates = aimCandidates;
    return aim;
  };
  // 步行中的武器輸入：1 / 2 / 3 直選（ACTIONS）、4 / 5 直選（SLOT_KEYS，未購買時 select 回 false）、Q 循環、R 裝填；
  // 攻擊（空手 / 球棒按一下、槍械按住連發：手槍半自動 0.22 s、衝鋒槍全自動 0.1 s、散彈槍泵動 1 s）取代 player.punch()
  const handleWeaponInput = (snap) => {
    fillAim(snap.down.aim);
    if (snap.pressed.slot1) weapons.select(0);
    else if (snap.pressed.slot2) weapons.select(1);
    else if (snap.pressed.slot3) weapons.select(2);
    else if (input.wasPressed(SLOT_KEYS[3])) weapons.select(3);
    else if (input.wasPressed(SLOT_KEYS[4])) weapons.select(4);
    if (snap.pressed.weaponCycle) weapons.cycle();
    if (snap.pressed.reload) weapons.reload();
    const fire = isGun(weapons.current) ? snap.down.attack : snap.pressed.attack;
    if (fire) weapons.attack(aim);
  };
  const whud = createWeaponHud({ root: document.body, touchRoot: document.getElementById('touch-ui'), weapons, input, isTouch: touch });
  const whudState = { driving: false, aimBlend: 0 };
  gunshotListeners(bus, () => traffic.brains.values()); // weapon:fire → 30 m 內行人 hear({ type: 'gunshot' })
  // 彈藥盒不放置（系統保留、points 為空）：手槍備彈無限（canPickup 恆 false）；Phase 14 衝鋒槍 / 散彈槍彈藥只在武器店購買或取得武器時附贈，
  // 不恢復地圖彈藥盒；pickup:ammo 仍依 payload.weapon 加到對應槍，日後傳入拾取點即生效
  const pickups = createAmmoPickups({ scene, bus, points: [], heightAt, canPickup: () => weapons.ammo().reserve < WEAPONS.pistol.reserveMax });
  bus.on('pickup:ammo', (e) => {
    const w = (e && e.weapon) || 'pistol';
    const n = weapons.addAmmo(e && e.amount, w);
    if (n > 0) hud.toast(`撿到${WEAPONS[w].label}子彈 ×${n}`, 2);
  });

  // ---------- 流血（W3）：只做地面血跡與血滴；settings.showBlood 由模組自行訂閱 ----------
  const blood = createBloodFx({ scene, settings, heightAt });
  combat.on('hit', (e) => bus.emit('combat:hit', e)); // payload 已含契約 §10 全欄位
  bus.on('combat:hit', (e) => blood.onHit(e));
  bus.on('ped:knockdown', (e) => blood.onKnockdown(e));

  // ---------- 音效（W2）：首次（與之後每次）使用者手勢 unlock；每幀 update 見 updateAudio ----------
  const audio = createAudio({ bus, settings });
  const unlockAudio = () => audio.unlock();
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
  // 車上電台（Phase 5）：輸出接 audio 的 master（已含主音量；radio 自己乘音樂音量，不接 music 群組以免乘兩次）；解鎖前 getOutput() = null
  const radio = createRadio({ getAudio: () => audio.getOutput(), getMusicVolume: () => settings.get('volumeMusic') });
  const radioCtx = { inVehicle: false, paused: true };

  // ---------- 打工委託（§23.4，jobs.js 由 createMissions 建立）：代客泊車的車輛轉接 ----------
  // spawnValetCar：vehicles.adopt（dynamic、靜止後 VehicleManager._park 自動轉 kinematic 停放）+ dmg.attach（損壞比 = healthOf）；
  //   同一亭先清掉上一趟留在客人車位 / 車格附近、玩家沒在開的泊車車（避免疊車擋車格）
  // releaseValetCar：打工結束（成功 / 失敗 / 讀檔作廢）→ 沒人開就拉手煞（停妥後轉路邊停放），之後比照搶來的車（adopted）遠離 ADOPTED_FAR 回收
  const valetCars = new Set();
  const removeValetCar = (v) => {
    dmg.detach(v);
    adopted.delete(v);
    valetCars.delete(v);
    vehicles.remove(v);
  };
  const spawnValetCar = (p) => {
    const site = valetSites.find((s) => Math.hypot(s.carX - p.x, s.carZ - p.z) < 1) || null;
    for (const v of [...valetCars]) {
      if (v.driven || v === state.vehicle) continue;
      const near = (x, z) => Math.hypot(v.pos.x - x, v.pos.z - z) < VALET_CLEAR_M;
      if (near(p.x, p.z) || (site && near(site.slotX, site.slotZ))) removeValetCar(v);
    }
    const look = VALET_CAR_LOOKS[Math.floor(Math.random() * VALET_CAR_LOOKS.length)];
    const v = vehicles.adopt({ type: look.type, color: look.color, x: p.x, z: p.z, yaw: p.yaw });
    dmg.attach(v);
    valetCars.add(v);
    return v;
  };
  const releaseValetCar = (v) => {
    if (!v || !vehicles.vehicles.includes(v)) return;
    if (!v.driven && v !== state.vehicle) v.setControls(driveControls({ x: 0, y: 0 }, true));
    adopted.add(v);
  };
  // 夜市跑單的客人點：路緣外人行道（job-props.js createSidewalkNear，沿用攤車擺位的 nearestRoadPoint）
  const sidewalkNear = createSidewalkNear({ nearestRoadPoint, onRoadSurface, buildingAt, inBounds });

  // ---------- 委託 / 導航 / 大地圖 / 打卡 / 小吃圖鑑（W4–W6）----------
  // keyTarget: window——手把選單模式的合成 KeyboardEvent 只送 window（path 不含 document），面板預設掛 document 會收不到；
  //   實體鍵盤事件本來就經過 window capture，不會重複處理（ui.js onKey 在面板關著時早退）
  const missions = createMissions({
    keyTarget: window,
    bus,
    scene,
    root: document.body,
    landmarks: landmarkPts,
    addMoney: (n, reason) => economy.add(n, reason),
    fetchJson,
    now: () => gameTime,
    rng: Math.random,
    heightAt,
    // 時段事件（夜市外送）：遊戲時刻取 dayNight.hour；路線長度走路網（graph 在下面才建，閉包取用時已存在）
    getGameHour: () => dayNight.hour,
    routeLength: (a, b) => findRoute(graph, a, b)?.lengthM,
    // 垃圾車事件（garbage-truck.js）：路線 = 玩家附近道路點 → 更遠道路點的 findRoute 折線（graph 同樣閉包取用）；玩家位置未知時用 focus
    routeFor: (p, rng) => garbageTruckRoute(graph, p || focus, rng),
    isTouch: touch, // 目標列 / 字幕操作詞：觸控「點「互動」鈕」、桌機「按 E」
    // 打工（§23.4）：夜市跑單 = oyster 攤（stall = placeProp 擺位、stallBack = 攤主側）、代客泊車 = VALET_SITES；車輛轉接見上
    jobSpots: { stall: runStall.stall, stallBack: runStall.stallBack, sidewalkNear, valet: valetSites },
    spawnValetCar,
    releaseValetCar,
    healthOf: (v) => dmg.healthOf(v),
    extraBusy: () => vigHooks.active(), // 警車任務進行中：委託 / 外送 / 垃圾車 / 打工都不開始（vigHooks 宣告在後，閉包取用）
  });
  const graph = buildRoadGraph(surfaceRoads);
  // 垃圾車車體：manifest garbage_truck 經 createVehicleModel 建立的純視覺模型（不建剛體、不進 VehicleManager / traffic → 不可上車 / 劫車、不進車流）；
  // 每幀 syncGarbageTruck 依 missions.truckState() 擺位 / 朝向，null 隱藏；車燈等發光材質沿用 registerNight（夜間發光），
  // beacon（警示燈）不登記 daynight，改由 applyBeacon(模板材質, tk.beaconLevel) 每幀設亮度（脈衝 × 日夜，garbage-truck.js）；glb 缺檔 → 無車體（事件照常）
  const truckModel = createVehicleModel('garbage_truck');
  const truckMesh = truckModel ? truckModel.root : null;
  if (truckMesh) {
    truckMesh.visible = false;
    truckMesh.rotation.order = 'YXZ';
    truckMesh.name = 'garbage-truck-event';
    scene.add(truckMesh);
    for (const m of vehicleTemplateMaterials('garbage_truck')) if (EMISSIVE_MATERIALS.includes(m.name)) registerNightOnce(m);
  }
  const truckMaterials = truckMesh ? vehicleTemplateMaterials('garbage_truck') : []; // 模板共用材質（applyBeacon 只動名稱含 beacon 者）
  const truckWheelR = truckModel ? truckModel.spec.wheelRadius || 0.46 : 0.46;
  // simDt：與 missions 推進車體的時間相同（輪子滾動角 = 行駛距離 / 輪徑）
  const syncGarbageTruck = (simDt) => {
    if (!truckMesh) return;
    const tk = missions.truckState();
    if (!tk) {
      if (truckMesh.visible) truckMesh.visible = false;
      return;
    }
    truckMesh.visible = true;
    truckMesh.position.set(tk.x, heightAt(tk.x, tk.z), tk.z);
    truckMesh.rotation.y = tk.heading;
    applyBeacon(truckMaterials, tk.beaconLevel);
    const roll = ((tk.speed || 0) * simDt) / truckWheelR;
    if (roll) for (const w of truckMesh.userData.wheels) w.rotation.x += roll;
  };
  // 接單攤檯面的外帶袋：夜市跑單開放接單時顯示（接單後 = 已帶走、收單 / 時段外隱藏）；takeout_bag 缺模型 → 無袋
  const syncTakeoutBags = () => {
    if (!takeoutBags.length) return;
    const on = !!(missions.jobs && missions.jobs.isOpen('night-market-run'));
    if (takeoutBags[0].visible !== on) for (const b of takeoutBags) b.visible = on;
  };
  const nav = createNavigator({ bus, graph, scene, heightAt });
  const checkins = createCheckins({ bus, landmarks: landmarkPts, addMoney: (n, reason) => economy.add(n, reason), root: document.body });
  const food = createFoodGuide({ bus, scene, root: document.body, fetchJson, addMoney: (n, reason) => economy.add(n, reason) });
  // 小地圖 / 大地圖標記：各模組 markers() 合併（陣列重用；小地圖另加路邊可開的車）
  const hudMarkers = [];
  const mapMarkers = [];
  const pushAll = (out, list) => {
    if (list) for (let i = 0; i < list.length; i++) out.push(list[i]);
  };
  const collectMarkers = (out, withVehicles) => {
    out.length = 0;
    pushAll(out, missions.markers());
    pushAll(out, nav.markers());
    pushAll(out, checkins.markers());
    pushAll(out, food.markers());
    pushAll(out, pickups.markers());
    pushAll(out, sprayMarkers);
    pushAll(out, robberyMarkers);
    pushAll(out, fugitiveMarkers());
    pushAll(out, streetMarkers());
    pushAll(out, raceMarkers());
    pushAll(out, sideJobMarkers());
    pushAll(out, gunShop.markers()); // Phase 14 武器店 / 安全屋
    pushAll(out, safehouses.markers());
    pushAll(out, rampageMarkers()); // Phase 15 暴走點（骷髏）
    pushAll(out, stuntMarkers()); // Phase 16 特技跳台（已完成淡化）
    pushAll(out, fireMarkers()); // P18 消防車任務起火車（kind 'fire'）
    pushAll(out, storyMarkers()); // P20 故事任務起點 S（kind 'story'）/ 目標圖釘（mission-dest）
    if (!withVehicles) packages.markers(out); // Phase 17 隱藏包裹：只有大地圖、只標已收集（淡化）
    if (withVehicles) for (const c of vehicles.vehicles) if (!c.driven && !c.fugitive) out.push(c.pos); // 逃犯車改畫紅點（fugitiveMarkers）
    return out;
  };
  const mapPlayer = { x: 0, z: 0, yaw: 0 };
  const bigMap = createBigMap({
    root: document.body,
    bus,
    zones: GANG_ZONES,
    landmarks: landmarkPts,
    getPlayer: () => {
      mapPlayer.x = focus.x;
      mapPlayer.z = focus.z;
      mapPlayer.yaw = state.mode === 'drive' && state.vehicle ? state.vehicle.yaw : player.yaw;
      return mapPlayer;
    },
    getMarkers: () => collectMarkers(mapMarkers, false),
    getLegendStats: () => [packages.progressText()], // Phase 17：圖例統計列「隱藏包裹 N / 20」（開啟時更新）
    getRoute: () => nav.route(),
    onPick: (x, z) => {
      nav.setDestination(x, z, '地圖標記', 'map', focus);
      bigMap.draw();
    },
  });
  // interactable 仲裁的候選（重用）；小吃 / 彈藥 / 武器店 / 安全屋只在步行時問
  const interCands = [null, null, null, null, null, null];
  const nearestInteractable = (pos, walking) => {
    interCands[0] = vigilante.active || races.active ? null : missions.nearest(pos); // 警車任務 / 街頭競速進行中不接委託（互斥）
    if (state.sideJob) interCands[0] = null; // 計程車 / 救護車副任務中同樣不接委託
    if (state.firefighter) interCands[0] = null; // 消防車任務（P18）出勤中不接委託
    if (state.story) interCands[0] = null; // 故事任務（P20）進行中不接委託
    interCands[1] = checkins.nearest(pos);
    interCands[2] = walking ? food.nearest(pos) : null;
    interCands[3] = walking ? pickups.nearest(pos) : null;
    interCands[4] = walking ? gunShop.nearest(pos) : null; // Phase 14：priority 2（委託 3 優先、同級取近）
    interCands[5] = walking ? safehouses.nearest(pos) : null;
    if (state.rampage) interCands[0] = interCands[4] = interCands[5] = null; // 暴走中不接委託、不進武器店 / 安全屋（暫發武器狀態不被購買 / 存檔改動）
    return pickInteractable(interCands);
  };
  // 互動提示與車輛提示互不覆蓋（hud 為單一膠囊，setPrompt / setInteractPrompt 各自會清掉另一則）：
  //   兩者都有 → hud.setPrompts 並列（「上車」鈕 ready 與 tb-interact 各自顯示）；只有一種 → 只呼叫對應那個；都沒有 → setPrompt(null) 清空
  //   hud 無 setPrompts / setInteractPrompt（舊版）時退回共用 setPrompt（車輛提示優先）
  const setPrompts = (vehicleText, inter) => {
    const text = inter ? inter.text : null;
    if (vehicleText && text) {
      if (hud.setPrompts) hud.setPrompts(vehicleText, text);
      else hud.setPrompt(vehicleText);
    } else if (text && hud.setInteractPrompt) hud.setInteractPrompt(text);
    else hud.setPrompt(vehicleText || text);
  };
  // 全螢幕面板：接單 / 結算（missions）、大地圖、圖鑑；開啟中世界與輸入暫停
  const panelOpen = () => missions.isModalOpen() || bigMap.isOpen() || food.isOpen() || gunShop.isOpen(); // 武器店購買面板（Phase 14）
  const hide3D = () => bigMap.isOpen() || food.isOpen(); // 大地圖 / 圖鑑蓋滿畫面：不渲染 3D
  const openGuide = () => {
    if (!state.started) return;
    food.open();
    if (menu.isOpen()) menu.close(); // 從暫停選單開：先開圖鑑再關選單（resumeGame 見到面板開著就不鎖滑鼠）
  };
  bus.on('ui:openGuide', () => openGuide());
  // 觸控圖鑑鈕：touch.js 預設註冊為隱藏佔位；此處（input 建立 = initTouch 之後）以同 id 帶 onTap 重新註冊後顯示
  registerTouchButton({ id: 'tb-guide', label: '圖鑑', slot: 'tl3', showWhen: 'walk', onTap: () => openGuide() });

  // ---------- 遊戲內手機（I6b，§23.3）----------
  // 地圖 / 設定 App 是啟動器：先關手機再開大地圖（syncPanels 鎖輸入）/ 暫停選單設定頁（pauseGame 鎖輸入）；syncPhone 見到面板 / 暫停就不還原輸入
  const phone = createPhone({
    root: document.body,
    bus,
    isTouch: touch,
    onOpenMap: () => {
      phone.close();
      bigMap.open();
      syncPanels();
      syncPhone();
    },
    onOpenSettings: () => {
      phone.close();
      menu.openPause('settings');
      syncPhone();
    },
    onNavigate: (it) => nav.setDestination(it.x, it.z, it.title, 'phone', focus),
  });
  const phoneJobs = []; // missions.listings 的輸出陣列（重用）
  const phoneLink = createPhoneLink({
    phone,
    input,
    canOpen: () => !state.respawn && canOpenPhone({ started: state.started, paused: state.paused, panelOpen: panelOpen(), menuOpen: menu.isOpen(), blocked: isInputBlocked() }),
    canResume: () => state.started && !state.paused && !panelOpen() && !menu.isOpen() && !state.respawn,
    // 開啟：同 syncPanels 的鎖定（放開滑鼠鎖定、清提示、駕駛中手煞）；世界不暫停
    onLock: () => {
      releaseLock();
      hud.setPrompt(null);
      hud.setInteractPrompt?.(null);
      if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    },
    fillData: (d) => {
      d.hour = dayNight.hour;
      d.weatherIcon = weather.getState().icon;
      d.money = economy.money;
      d.jobs = missions.listings(focus, phoneJobs);
    },
  });
  const syncPhone = () => phoneLink.sync();
  const openPhone = () => phoneLink.open();
  // 觸控手機鈕：touch.js 預設為隱藏佔位（tl4）；以同 id 帶 onTap 重新註冊後顯示（input.enabled = false 時觸控層不吃，關閉走手機內返回鈕）
  registerTouchButton({ id: 'tb-phone', label: '手機', slot: 'tl4', showWhen: 'always', onTap: () => openPhone() });

  // ---------- 存檔與經濟 ----------
  let storage;
  try {
    storage = window.localStorage; // 停用儲存時存取本身就會丟例外 → 交給 save.js 退回記憶體
  } catch (err) {
    storage = undefined;
  }
  const store = createSaveStore({ storage });
  const initialLoad = store.load(); // 只為了取得狀態提示（繼續時會重新讀）
  let economy = createEconomy({ bus, initial: initialLoad.data });
  // 整合層自行累加的統計（economy 不訂閱這些事件）：startGame 時由存檔初始化
  const extraStats = { missionsDone: 0, missionsFailed: 0, shotsFired: 0, pedsKnockedOut: 0 };
  const resetExtraStats = (stats) => {
    extraStats.missionsDone = (stats && stats.missionsDone) || 0;
    extraStats.missionsFailed = (stats && stats.missionsFailed) || 0;
    extraStats.shotsFired = (stats && stats.shotsFired) || 0;
    extraStats.pedsKnockedOut = 0; // 只記本局 bat / bullet 擊倒（存檔值已在 economy 的 pedsKnockedOut 內）
  };
  resetExtraStats(initialLoad.data && initialLoad.data.stats);
  // 委託與時段事件（夜市外送）的完成 / 失敗（含放棄）各計一次 missionsDone / missionsFailed
  trackMissionStats(bus, extraStats);
  bus.on('weapon:fire', (e) => {
    if (e && e.byPlayer) extraStats.shotsFired++;
  });
  // economy 的 loot 只認 punch：球棒 / 槍擊打倒路人比照拳擊掉 NT$10–40（reason 'loot'）並記 pedsKnockedOut
  bus.on('ped:knockdown', (e) => {
    if (!e || !e.byPlayer || (e.cause !== 'bat' && e.cause !== 'bullet')) return;
    extraStats.pedsKnockedOut++;
    economy.add(LOOT_MIN + Math.floor(Math.random() * (LOOT_MAX - LOOT_MIN + 1)), 'loot');
  });
  const currentStats = () => ({ ...statsWithExtra(economy.stats, extraStats), hiddenPackages: packages.found, hiddenPackagesTotal: packages.total }); // Phase 17：統計頁「隱藏包裹 N / 20」（packages 於下方建立，呼叫時已存在）
  // 存檔 schema v2（契約 §18）：weapons / missions / collect
  const autosave = createAutosave({
    store,
    intervalSec: AUTOSAVE_SEC,
    getState: () => {
      const p = state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos;
      const snap = economy.snapshot();
      return {
        version: SAVE_VERSION,
        money: snap.money,
        stats: statsWithExtra(snap.stats, extraStats),
        player: { x: p.x, z: p.z, yaw: player.yaw },
        world: { hour: dayNight.hour },
        weapons: rampage.savedWeapons() || weapons.serialize(), // 暴走中存開始前的武器狀態（暫發武器不入檔）
        missions: missions.serialize(),
        collect: { checkins: checkins.serialize(), foods: food.serialize() },
        races: races.serialize(), // Phase 12：街頭競速最佳成績（無紀錄 = null，存檔省略）
        safehouse: safehouses.serialize(), // Phase 14：最後使用的安全屋（沒用過 = null，存檔省略）
        rampage: rampage.serialize(), // Phase 15：已完成的暴走點（沒有 = null，存檔省略）
        stunts: stunts.serialize(), // Phase 16：已完成的特技跳台（沒有 = null，存檔省略）
        packages: packages.serialize(), // Phase 17：隱藏包裹 { found, tier, bonus }（一個都沒收集 = null，存檔省略）
        firefighter: firefighter.serialize(), // P18：消防車任務 { fireproof, best }（未玩過 = null，存檔省略）
        story: story.serialize(), // P20：故事任務 { chapter, done, unlocked }（一關都沒完成 = null，存檔省略）
      };
    },
  });
  let saveNotice = {
    recovered: '主存檔讀取失敗，已從備份還原',
    'corrupt-reset': '存檔損毀，已重設為新遊戲',
    incompatible: '存檔版本較新，無法讀取；開始新遊戲才會覆寫',
  }[initialLoad.status];

  // ---------- 上下車 ----------
  // 開始上車：面向車輛播 enter_car（動作被拒，例如正在出拳 / 受擊，就不上車）
  const beginEnter = (v) => {
    if (!player.anim.trigger('enter_car')) return false;
    player.yaw = Math.atan2(v.pos.x - player.pos.x, v.pos.z - player.pos.z);
    state.mode = 'entering';
    state.vehicle = v;
    player.locked = true;
    hud.setPrompt(null);
    return true;
  };

  // enter_car 播完（animator 已進 drive）：真正進入駕駛；機車看得到騎士，汽車把角色藏起來（坐在座位點）
  const enterVehicle = (v, carjack = false) => {
    state.mode = 'drive';
    state.vehicle = v;
    vehicles.drive(v, true);
    player.enterVehicle();
    player.locked = false;
    player.actor.untargetable = true;
    player.mesh.visible = !!v.spec.twoWheeler;
    // 搶車時角色停在 punch 之後的移動狀態：補播 enter_car，播完 animator 自動進 drive 坐姿
    if (player.anim.state !== 'drive') player.anim.trigger('enter_car');
    player.sitOn(v);
    hud.setPrompt(null);
    hud.setInteractPrompt?.(null);
    whud.setDriving(true);
    applyWeaponModel(); // 駕駛中隱藏武器模型
    bus.emit('vehicle:enter', { vehicle: v, carjack });
  };

  // 上車動作被打斷（受擊 / 倒地）：回步行
  const cancelEnter = () => {
    state.mode = 'walk';
    state.vehicle = null;
    player.locked = false;
  };

  // 下車：駕駛座側附近找無碰撞的站立點；找不到就留在車上並提示。force（機車倒地 / 回主選單）：找不到空位就站在車身位置
  const q = {};
  const exitVehicle = (force = false) => {
    const v = state.vehicle;
    if (!v) return false;
    if (!player.exitVehicle(v)) {
      if (!force) {
        hud.toast('車旁沒有空位，無法下車', 2);
        return false;
      }
      const y = terrain.querySurface(v.pos.x, v.pos.z, v.pos.y + 1, q).y;
      player.body.setEnabled(true);
      player.body.teleport(v.pos.x, y, v.pos.z);
      player.pos.set(v.pos.x, y, v.pos.z);
      player.syncMesh();
    }
    vehicles.drive(v, false);
    state.vehicle = null;
    state.mode = 'walk';
    player.actor.untargetable = false;
    player.mesh.visible = true;
    whud.setDriving(false);
    applyWeaponModel();
    bus.emit('vehicle:exit', { vehicle: v });
    return true;
  };

  // 玩家直接倒地（機車倒地摔下）：combat.knockdownActor（契約 §13；不發 knockdown 事件、hp 不變、播倒地動畫），
  // 之後由 combat.update 的 settleCheck → getup 流程起身
  const knockDownPlayer = () => {
    combat.knockdownActor(player.actor, { cause: 'fall' });
  };
  vehicles.onFall = (v) => {
    if (state.mode === 'drive' && state.vehicle === v) state.pendingFall = v;
  };
  const handleFall = () => {
    const v = state.pendingFall;
    state.pendingFall = null;
    if (!v || state.vehicle !== v || state.mode !== 'drive') return;
    // P19：倒地當幀即下車，updateSnatch 看不到翻覆 → 下車前先通知摔車（掉一半並重置連擊）
    if (v.type === 'scooter') snatch.crash();
    exitVehicle(true);
    knockDownPlayer();
    hud.toast('機車倒地，你摔下車了', 2.5);
  };

  // ---------- 搶車 ----------
  const cj = createCarjack({ bus });
  // 搶走受損 / 起火中的車流車：耐久與起火狀態（引信 / 來源）帶到新 Vehicle（不因轉手變回滿血無火）
  let jackFrom = null;
  let jackHealth = null;
  const carjackAdapters = {
    releaseCar: (car) => {
      jackFrom = car ? car.v : null;
      jackHealth = jackFrom ? dmg.healthOf(jackFrom) : null;
      return traffic.releaseCar(car);
    },
    adopt: (pose) => {
      const v = vehicles.adopt(pose);
      dmg.attach(v);
      adopted.add(v);
      if (v && jackHealth !== null) {
        const lost = dmg.maxHealthOf(v) - jackHealth;
        explosions.transfer(jackFrom, v, () => {
          if (lost > 0) dmg.addDamage(v, lost);
        });
      }
      jackFrom = null;
      jackHealth = null;
      return v;
    },
    spawnEjectedDriver: (o) => traffic.spawnEjectedDriver({ ...o, attacker: player.actor }),
    playPlayerAnim: (name) => player.anim.trigger(name),
    facePlayer: (yaw) => {
      player.yaw = yaw;
    },
    isPlayerDisabled: () => state.koTimer > 0 || !!state.respawn || combat.isDown(player.actor),
    onEnter: (v) => enterVehicle(v, true),
  };
  const beginCarjack = (candidate) => {
    if (!cj.begin({ candidate, adapters: carjackAdapters })) return false;
    // begin 內可能已在同一呼叫中結束（releaseCar 失敗）；進行中才鎖輸入
    if (cj.active) {
      state.mode = 'carjack';
      player.locked = true;
    }
    hud.setPrompt(null);
    return true;
  };
  const updateCarjack = (dt) => {
    const r = cj.update(dt);
    if (r === 'running') return;
    // done：onEnter 已切到 drive；cancelled（被打倒等）：回步行，已 adopt 的車留在原地當路邊車
    if (state.mode === 'carjack') {
      state.mode = 'walk';
      player.locked = false;
    }
  };

  // ---------- 對抗 / KO ----------
  // 行人倒地 → 契約事件 ped:knockdown（經濟：打倒掉錢、撞人統計）；玩家 hp 歸零 → player:ko（economy 扣醫藥費），
  // 倒地 WASTED_DELAY_SEC 後走送醫（WASTED，beginRespawn）；任務改在 WASTED 時以 reason 'wasted' 失敗（不再呼叫 missions.onPlayerKo）
  let koFee = WASTED_FEE; // 最近一次 player:ko 實扣的醫藥費（送醫畫面 / player:wasted 顯示實扣值）
  combat.on('knockdown', (e) => {
    const p = pedKnockdownPayload(e);
    if (p) bus.emit('ped:knockdown', p);
    if (e.target !== player.actor || player.actor.hp > 0 || state.respawn || state.koTimer > 0) return;
    state.koTimer = WASTED_DELAY_SEC;
    const before = economy.money;
    bus.emit('player:ko', {});
    koFee = Math.max(0, before - economy.money); // economy 在 player:ko 實扣的醫藥費（餘額不足時 < HOSPITAL_FEE）
  });
  const updateKnockout = (dt) => {
    if (state.koTimer <= 0) return;
    state.koTimer -= pw.simTimeFor(dt); // 模擬計時：本幀物理將推進的秒數（物理 step 前呼叫，累加器尚未變）
    if (state.koTimer > 0) return;
    state.koTimer = 0;
    beginRespawn('wasted');
  };

  // ---------- 通緝（Phase 7）：wanted（星數）/ police（警力大腦）/ policeAdapters（世界轉接）/ wantedUI（星星列、被捕 / 送醫畫面）----------
  const playerPos = () => (state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos);
  const wanted = createWanted({ bus });
  const policeAdapters = createPoliceAdapters({
    vehicles,
    dmg,
    traffic,
    findRoute: (a, b) => findRoute(graph, a, b),
    combat,
    characters: { createCharacter, disposeCharacter, CharacterAnimator, clips: getCharacterManifest()?.clips || [] },
    physics,
    scene,
    heightAt,
    blocked: (x, z) => !!buildingAt(x, z) || inWater(x, z),
    audio,
    settings,
    bus,
    getPlayer: () => {
      const p = playerPos();
      const v = state.mode === 'drive' ? state.vehicle : null;
      return { x: p.x, z: p.z, actor: player.actor, inVehicle: !!v, speed: v ? Math.abs(v.speed || 0) : 0, vehicle: v };
    },
    isNight: () => dayNight.night > 0.5,
    surfaceOffset: SURFACE_OFFSET,
    // V5：車內中彈扣玩家車耐久、路障找路口（車道路網度數 ≥ 3 的節點）、路障路錐
    damageVehicle: (v, n) => dmg.addDamage(v, n),
    graph,
    createCone: () => createRoadCone(),
  });
  const police = createPolice({ bus, wanted, adapters: policeAdapters });
  // 掛 document.body（同 weapons hud；#hud 是 z-index 10 的堆疊環境，wanted.css 的 z 53–54 要在 body 層才生效）；回主選單時 cancelRespawn 清星 → 星星列隱藏
  // hints: hud → 首次通緝提示走 HUD 提示卡與 tcgta.hints.seen（hud.resetHints() 一併重置）
  const wantedUI = createWantedUI({ root: document.body, canvas: renderer.domElement, hints: hud });
  // 星星列：wanted:change / wanted:state → setStars（searching 閃爍）；首次被通緝出提示卡（委派 HUD，同 id 只出一次）
  const syncStars = () => wantedUI.setStars(wanted.stars, { flashing: wanted.flashing });
  bus.on('wanted:change', (e) => {
    syncStars();
    if (e && e.stars > 0 && !(e.prev > 0) && settings.get('showHints')) wantedUI.showHint('wanted', WANTED_HINT_TEXT);
  });
  bus.on('wanted:state', () => syncStars());
  // 警車任務（Phase 11）掛鉤：犯行豁免（下車逃犯 / 子彈落點在逃犯車旁）與被捕 / 送醫結束任務；預設無作用，警車任務段建立 vigilante 後覆寫
  const vigHooks = { fugitiveActor: () => false, fugitiveShot: () => false, end: () => {}, active: () => false };
  // V5 警方升級掛鉤（直升機 seen / 開新局回收）：預設無作用，V5 段（爆炸段之後）建立直升機後覆寫
  const policeV5 = { update: () => false, cancel: () => {} };

  // ---------- 噴漆廠（Phase 8）：src/wanted/spray.js（純邏輯）+ 入口光柱 + 小地圖 / 大地圖標記 ----------
  const sprayShops = createSprayShops({ bus, wanted, police, shops: SPRAY_SHOPS });
  const sprayMarkers = SPRAY_SHOPS.map((s) => ({ x: s.x, z: s.z, kind: 'spray-shop' }));
  const sprayBeacons = createBeaconPool({ scene, heightAt });
  for (const s of SPRAY_SHOPS) sprayBeacons.acquire('spray', s.x, s.z, s); // 常駐不釋放
  // 每幀 ctx：vehicle 只在駕駛中提供（duck type：x / z / speed / isPolice / color / repaint / repair / ref）
  // repaint / repair 只建一次，經 sprayTarget 指向本幀駕駛的車；ref = 實體車（spray.js 據此判斷中途換車 / 下車而中止）
  let sprayTarget = null;
  const sprayVehicle = {
    x: 0, z: 0, speed: 0, isPolice: false, color: null, ref: null,
    repaint: (color) => sprayTarget && sprayTarget.repaint(color),
    repair: () => sprayTarget && dmg.repair(sprayTarget),
  };
  const sprayCtx = { player: { x: 0, z: 0 }, vehicle: null, money: 0, spend: null, seen: false };
  // economy.spend 為原子操作（餘額不足整筆拒扣、回 false）→ 實扣只會是 n 或 0，不需 refund；spray.js 在噴完才呼叫
  sprayCtx.spend = (n) => (economy.spend(n, 'spray') ? n : 0);
  let lastPoliceSeen = false; // updateWanted 本幀算出的 police.update seen，供噴漆廠「被看見」判定共用（不重算）
  const updateSprayShops = (dt) => {
    sprayBeacons.update(dt);
    // 警車任務進行中：視同未駕駛（不開始噴漆，互斥）
    if (state.mode === 'drive' && state.vehicle && !state.respawn && !vigHooks.active()) {
      const v = state.vehicle;
      sprayVehicle.x = v.pos.x;
      sprayVehicle.z = v.pos.z;
      sprayVehicle.speed = v.speed;
      sprayVehicle.isPolice = policeAdapters.isPoliceVehicle(v);
      sprayVehicle.color = v.color;
      sprayVehicle.ref = v;
      sprayTarget = v;
      sprayCtx.vehicle = sprayVehicle;
    } else {
      sprayTarget = null;
      sprayVehicle.ref = null;
      sprayCtx.vehicle = null;
    }
    const p = playerPos();
    sprayCtx.player.x = p.x;
    sprayCtx.player.z = p.z;
    sprayCtx.money = economy.money;
    sprayCtx.seen = wanted.stars > 0 && lastPoliceSeen; // 0 星時巡邏車視線不算「被看見」
    const r = sprayShops.update(state.respawn ? 0 : dt, sprayCtx);
    if (r.active && !state.spraying) {
      state.spraying = r.shopId;
      input.enabled = false;
      if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    } else if (!r.active && state.spraying) {
      state.spraying = null;
      hud.setSprayFade(0);
      if (state.started && !state.paused && !panelOpen() && !phone.isOpen() && !state.respawn) input.enabled = true;
    }
    if (r.active) hud.setSprayFade(r.progress < 0.5 ? r.progress * 2 : (1 - r.progress) * 2);
  };
  // 回主選單 / 開新局：立即取消進行中的噴漆（不扣錢 / 不換色 / 不 toast）並收掉黑幕；須在 cancelRespawn 之前呼叫
  // （cancelRespawn 的 wanted.clear('debug') 會 emit wanted:cleared，先取消才不會多跳「噴漆中斷」）
  const cancelSpray = () => {
    sprayShops.cancel();
    state.spraying = null;
    sprayTarget = null;
    hud.setSprayFade(0);
  };

  // 犯行回報（只算玩家所為）：警力看得見（police.witness）→ 全額；否則 CRIME_REPORT_RANGE 內有行人 → 路人報案（witnessed=false）；都沒有 → 不報
  const isOfficer = (a) => !!a && (a.faction === 'police' || !!a.officer);
  const peopleNear = (x, z, r, withOfficers) => {
    const r2 = r * r;
    // traffic.citizens 元素：替身時位置在 c.x / c.z，掛骨架後即時位置在 c.ped.x / c.ped.z（同 traffic.js LOD 迴圈的 c.ped || c）
    for (const c of traffic.citizens) {
      const o = c.ped || c;
      if ((o.x - x) ** 2 + (o.z - z) ** 2 <= r2) return true;
    }
    if (withOfficers) for (const o of police.officers) if ((o.pos.x - x) ** 2 + (o.pos.z - z) ** 2 <= r2) return true;
    return false;
  };
  const reportCrime = (crime, x, z) => {
    if (!state.started || state.respawn) return false;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      const p = playerPos();
      x = p.x;
      z = p.z;
    }
    const witnessed = police.witness(x, z);
    if (!witnessed && !peopleNear(x, z, CRIME_REPORT_RANGE, false)) return false;
    wanted.report(crime, { x, z, witnessed });
    return true;
  };
  bus.on('combat:hit', (e) => {
    if (!e || !e.byPlayer || !e.target || e.target === player.actor || e.weapon === 'vehicle') return; // 車撞走 ped:knockdown / ped:dead
    if (vigHooks.fugitiveActor(e.target)) return; // 警車任務：攻擊下車的逃犯不算犯行
    reportCrime(isOfficer(e.target) ? CRIMES.assaultPolice : CRIMES.assault, e.x, e.z);
  });
  bus.on('ped:dead', (e) => {
    if (!e || !e.byPlayer || vigHooks.fugitiveActor(e.ped)) return;
    const crime = isOfficer(e.ped) ? CRIMES.killPolice : e.cause === 'vehicle' ? CRIMES.vehicleKill : CRIMES.kill;
    reportCrime(crime, e.x, e.z);
  });
  bus.on('ped:knockdown', (e) => {
    if (e && e.byPlayer && e.cause === 'vehicle' && !vigHooks.fugitiveActor(e.ped)) reportCrime(CRIMES.vehicleHit, e.x, e.z);
  });
  bus.on('weapon:fire', (e) => {
    // 警員開槍（adapters：police true / byPlayer false）不算；玩家開槍要 CRIME_GUNFIRE_RANGE 內有行人或警員
    if (!e || !e.byPlayer || e.police) return;
    if (vigHooks.fugitiveShot(e.ex, e.ez, e.vehicle)) return; // 警車任務：射擊逃犯車（落點在逃犯車附近）、街頭事件：打中罪犯車本身（e.vehicle）不算 gunfire
    if (peopleNear(e.x, e.z, CRIME_GUNFIRE_RANGE, true)) reportCrime(CRIMES.gunfire, e.x, e.z);
  });
  // 搶警車：每台只算一次 policeVehicle；路邊上車開走警車（警車不走 carjack 流程）比照搶車另報 carjack
  const stolenPolice = new WeakSet();
  const reportPoliceTheft = (v) => {
    if (!v || !policeAdapters.isPoliceVehicle(v) || stolenPolice.has(v)) return;
    stolenPolice.add(v);
    reportCrime(CRIMES.policeVehicle, v.pos.x, v.pos.z);
  };
  bus.on('vehicle:carjacked', (e) => {
    const v = e && e.vehicle;
    const p = v ? v.pos : playerPos();
    reportCrime(CRIMES.carjack, p.x, p.z);
    reportPoliceTheft(v);
  });
  bus.on('vehicle:enter', (e) => {
    const v = e && e.vehicle;
    if (!v || e.carjack || !policeAdapters.isPoliceVehicle(v) || stolenPolice.has(v)) return;
    reportCrime(CRIMES.carjack, v.pos.x, v.pos.z);
    reportPoliceTheft(v);
  });
  // 玩家駕車撞警車（contacts router 的車對車碰撞，見下方 onVehicleHitVehicle）
  const policeRamAt = new WeakMap();
  const onPlayerRam = (mine, other, relSpeed) => {
    if (!other || !policeAdapters.isPoliceVehicle(other) || stolenPolice.has(other) || !(relSpeed >= POLICE_RAM_MIN_SPEED)) return;
    if (Math.abs(mine.speed || 0) <= Math.abs(other.speed || 0)) return;
    const last = policeRamAt.get(other);
    if (last !== undefined && gameTime - last < POLICE_RAM_COOLDOWN) return;
    policeRamAt.set(other, gameTime);
    reportCrime(CRIMES.policeVehicle, mine.pos.x, mine.pos.z);
  };

  // 每幀（updateGame，暫停 / 全螢幕面板 / 手機開著時不跑）：policeAdapters.update → police.update → wanted.update(seen)
  const adapterCtx = { stars: 0, listener: null, paused: false };
  const adapterIdle = { stars: 0, listener: null, paused: true }; // 不更新時以 dt 0 靜音警笛
  const policeCtx = { player: { x: 0, z: 0, inVehicle: false, speed: 0, down: false, dirX: NaN, dirZ: NaN } };
  const wantedCtx = { playerX: 0, playerZ: 0, seen: false };
  const updateWanted = (dt, skip) => {
    if (skip) {
      policeAdapters.update(0, adapterIdle);
      return;
    }
    const v = state.mode === 'drive' ? state.vehicle : null;
    const p = v ? v.pos : player.pos;
    adapterCtx.stars = wanted.stars;
    adapterCtx.listener = camera.position;
    policeAdapters.update(dt, adapterCtx);
    const pl = policeCtx.player;
    pl.x = p.x;
    pl.z = p.z;
    pl.inVehicle = !!v;
    pl.speed = v ? Math.abs(v.speed || 0) : 0;
    pl.down = state.koTimer > 0 || !!state.respawn || combat.isDown(player.actor);
    pl.dirX = v ? Math.sin(v.yaw) : NaN; // 駕駛中以車頭方向當前進方向（路障）；步行由 police.js 以位移取樣
    pl.dirZ = v ? Math.cos(v.yaw) : NaN;
    const { seen: groundSeen } = police.update(dt, policeCtx);
    const seen = policeV5.update(dt, pl) || groundSeen; // V5：直升機探照燈照到也算被看見
    lastPoliceSeen = seen; // 噴漆廠（spray.js）「被警力看見中」沿用本幀結果，不重算
    wantedCtx.playerX = p.x;
    wantedCtx.playerZ = p.z;
    wantedCtx.seen = seen;
    wanted.update(dt, wantedCtx);
  };
  // 小地圖警車點（police.cars 的 pos，陣列重用）
  const policeDots = [];
  const collectPoliceDots = () => {
    policeDots.length = 0;
    for (const c of police.cars) policeDots.push(c.pos);
    return policeDots;
  };

  // 被捕 / 送醫：鎖輸入、玩家不受攻擊 → 全螢幕畫面（被捕另扣罰鍰；送醫的醫藥費 economy 已在 player:ko 扣）、進行中任務以 kind 失敗；
  // 畫面結束（自動 3.5 s 或點擊跳過）→ finishRespawn：傳送到警察局 / 醫院門口、hp 回滿、wanted.clear(kind)、emit player:busted / player:wasted、解鎖
  let respawnSeq = 0;
  const beginRespawn = (kind) => {
    if (state.respawn || state.spraying) return; // 噴漆廠換色期間與 BUSTED / WASTED 互斥
    const at = playerPos();
    const x = at.x;
    const z = at.z;
    state.respawn = kind;
    const seq = ++respawnSeq;
    // 取消進行中的上車動畫 / 搶車：畫面期間不得完成上車（否則上警車不報、搶車照樣完成）
    if (cj.active) cj.cancel();
    if (state.mode === 'entering') cancelEnter();
    if (state.mode === 'carjack') state.mode = 'walk';
    input.enabled = false;
    player.locked = true;
    player.actor.untargetable = true;
    if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    hud.setPrompt(null);
    hud.setInteractPrompt?.(null);
    let shown;
    let paid; // 實扣金額：畫面與 player:busted / player:wasted payload 一律顯示實扣值
    if (kind === 'busted') {
      // economy 對外只有 spend（餘額不足整筆拒扣）：扣 min(罰鍰, 餘額) = 不足扣到 0
      const fine = Math.min(BUSTED_FINE, economy.money);
      if (fine > 0) economy.spend(fine, 'busted');
      paid = fine;
      shown = wantedUI.showBusted({ fine });
    } else {
      paid = koFee;
      shown = wantedUI.showWasted({ fee: koFee });
    }
    missions.failActive(kind);
    vigHooks.end(kind);
    // 只有畫面正常結束（done / skipped）才重生；preempted / disposed 不重複傳送
    Promise.resolve(shown).then((r) => {
      if (r && (r.reason === 'done' || r.reason === 'skipped')) finishRespawn(kind, seq, x, z, paid);
    });
  };
  const finishRespawn = (kind, seq, x, z, paid) => {
    if (seq !== respawnSeq || state.respawn !== kind) return; // 期間已開新局 / 回主選單（cancelRespawn）
    state.respawn = null;
    if (cj.active) cj.cancel();
    if (state.mode === 'drive') exitVehicle(true);
    state.mode = 'walk';
    state.vehicle = null;
    state.koTimer = 0;
    state.pendingFall = null;
    const place = respawnPlace(kind);
    player.placeAt(place.x, place.z, place.yaw, terrain);
    player.recoverAfterKnockout(terrain); // 門口被車 / 人佔住時就近找空位（原地 3 m 內優先）
    if (combat.isDown(player.actor)) combat.revive(player.actor);
    player.actor.hp = player.actor.maxHp;
    player.locked = false;
    player.actor.untargetable = false;
    player.mesh.visible = true;
    rig.yaw = place.yaw;
    lastPos.copy(player.pos);
    focus.copy(player.pos);
    wanted.clear(kind);
    if (kind === 'busted') bus.emit('player:busted', { fine: paid, x, z });
    else bus.emit('player:wasted', { fee: paid, x, z });
    if (state.started && !state.paused && !panelOpen() && !phone.isOpen()) input.enabled = true;
  };
  // 新局 / 回主選單：作廢進行中的被捕 / 送醫流程（畫面自行結束）並清通緝
  const cancelRespawn = () => {
    respawnSeq++;
    state.respawn = null;
    player.actor.untargetable = state.mode === 'drive';
    wanted.clear('debug');
  };
  bus.on('police:bust', () => {
    if (state.started) beginRespawn('busted');
  });

  // ---------- 車輛耐久：contacts router → onImpact（以 body.owner 找 Vehicle，未 attach 的車流車由 dmg 忽略）----------
  const byPlayer = (v) => state.mode === 'drive' && state.vehicle === v;
  let blastSource = null; // explosions.setSource（V4 段建立後綁定）
  // 易碎貨物：玩家駕駛車輛的每次碰撞（≥ IMPACT_MIN = 4 m/s）都通知委託；不依賴 vehicle:crash（只在 ≥ 8 m/s 發出）
  // 兩個來源：contacts 的 relSpeed（先於耐久計算，不受 dmg 去重 / 未 attach 影響）與 vehicle:damaged 的 delta（反推等效速度）；
  // 同一次碰撞兩路都回報時，missions 以 IMPACT_MERGE_SEC 視窗只取最大值，不會重複累積
  const impactArg = { relSpeed: 0 };
  const reportImpact = (relSpeed) => {
    if (!(relSpeed >= MISSION_IMPACT_MIN)) return;
    impactArg.relSpeed = relSpeed;
    missions.onVehicleImpact(impactArg);
  };
  const impact = (entity, relSpeed, kind) => {
    const v = entity && entity.owner;
    if (!v) return;
    const mine = byPlayer(v);
    if (mine) reportImpact(relSpeed);
    const d = dmg.onImpact(v, { relSpeed, kind, byPlayer: mine });
    // V4：只有玩家駕駛的這次碰撞實際扣到耐久才記為玩家造成（爆炸致死照犯行計算）；explosions 於下方建立，執行期才會呼叫
    if (mine && d > 0 && typeof blastSource === 'function') blastSource(v, player.actor); // typeof：integration-p4 抽段執行時 blastSource 不在範圍內
  };
  bus.on('vehicle:damaged', ({ vehicle, delta }) => {
    if (!byPlayer(vehicle) || !(delta > 0)) return;
    reportImpact(impactSpeedFromDamage(vehicle, delta));
  });
  router.onVehicleHitWorld(({ vehicle, relSpeed }) => impact(vehicle, relSpeed, 'static'));
  router.onVehicleHitVehicle(({ a, b, relSpeed }) => {
    impact(a, relSpeed, 'vehicle');
    impact(b, relSpeed, 'vehicle');
    const va = a && a.owner;
    const vb = b && b.owner;
    if (va && byPlayer(va)) onPlayerRam(va, vb, relSpeed);
    else if (vb && byPlayer(vb)) onPlayerRam(vb, va, relSpeed);
  });
  router.onVehicleHitPedestrian(({ vehicle, relSpeed }) => impact(vehicle, relSpeed, 'ped'));
  bus.on('vehicle:crash', ({ relSpeed }) => rig.shake(Math.min(1, relSpeed / CRASH_SHAKE_SPEED)));
  // 遊戲手把（gamepad.js）：輪詢掛在 input 每幀 hook；步行 / 駕駛沿用 state.mode，十字鍵 ← 上一把武器讀 weapons.pending（排隊中優先）/ weapons.slot
  // 震動只接既有事件：玩家開槍（weapon:fire byPlayer）一次短震、玩家駕駛碰撞（vehicle:crash，≥ 8 m/s）依撞擊速度；手把不支援震動時略過
  const gamepad = createGamepad(input, { getMode: () => state.mode, getSlot: () => (weapons.pending >= 0 ? weapons.pending : weapons.slot), getPrevSlot: () => weapons.prevSlot(), getSprayMode: () => state.mode === 'drive' && isFireTruck(state.vehicle) });
  bus.on('weapon:fire', (e) => {
    if (e && e.byPlayer) gamepad.rumble(0.2, 0.6, 70);
  });
  bus.on('vehicle:crash', ({ relSpeed }) => {
    const k = Math.min(1, relSpeed / CRASH_SHAKE_SPEED);
    gamepad.rumble(k, 0.4 + 0.6 * k, 120 + 230 * k);
  });
  bus.on('vehicle:disabled', ({ vehicle }) => {
    if (byPlayer(vehicle)) hud.toast('車子熄火了', 2.5);
  });
  bus.on('vehicle:recovered', ({ driven }) => {
    if (driven) hud.toast('車輛已重置到道路上', 2.5);
  });

  // 回收：玩家已離開的搶來車（遠了）與熄火報廢車（遠了）
  let cleanupT = 0;
  const cleanupVehicles = (simDt, center) => {
    cleanupT += simDt;
    if (cleanupT < CLEANUP_SEC) return;
    cleanupT = 0;
    for (const v of vehicles.vehicles.slice()) {
      if (v.driven || v === state.vehicle || v === cj.vehicle) continue;
      const d = Math.hypot(v.pos.x - center.x, v.pos.z - center.z);
      const wreck = dmg.healthOf(v) === 0;
      if ((adopted.has(v) && d > ADOPTED_FAR) || (wreck && d > WRECK_FAR)) {
        dmg.detach(v);
        adopted.delete(v);
        valetCars.delete(v);
        vehicles.remove(v);
      }
    }
  };

  // ---------- 警車任務（Phase 11，§29）：src/missions/vigilante.js（純邏輯）+ 逃犯車世界介面 + 任務條 + 小地圖 / 大地圖紅點 ----------
  // 犯行豁免 / 被捕送醫結束經 vigHooks（宣告在通緝段，犯行監聽與 beginRespawn 只認掛鉤）
  const vigilante = createVigilante({ bus, wanted, rng: Math.random });
  // 回收時保留：玩家正駕駛 / 正上車 / 搶車中的逃犯車；保留下來的車併入 adopted（玩家離開後遠了照一般搶來車回收）
  const fugitiveWorld = createFugitiveWorld({
    vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng: Math.random, attacker: () => player.actor,
    isKept: (v) => v === state.vehicle || v === cj.vehicle,
    onKeep: (v) => adopted.add(v),
  });
  const vigBar = createVigilanteBar({ root: document.body });
  vigHooks.fugitiveActor = (a) => vigilante.isFugitiveActor(a);
  vigHooks.fugitiveShot = (x, z) => vigilante.shotAtFugitive(x, z);
  vigHooks.end = (kind) => {
    vigilante.end(kind);
    vigBar.set(null); // BUSTED / WASTED：updateVigilante 在 respawn 期間早退，任務條在此收起
  };
  vigHooks.active = () => vigilante.active;
  const vigMarkers = [];
  const fugitiveMarkers = () => {
    vigMarkers.length = 0;
    return vigilante.markers(vigMarkers);
  };
  // 警車：警力生成的警車（policeAdapters，含被玩家開走的）或路邊停放的 police 車型
  const isPoliceCar = (v) => !!v && (v.type === 'police' || policeAdapters.isPoliceVehicle(v));
  // 其他任務進行中（委託 / 外送 / 追垃圾車 / 打工 / 搶劫 / 噴漆）→ 不可開始警車任務
  const otherMissionBusy = () => !!(state.sideJob || missions.active() || missions.eventActive() || missions.jobActive() || robberies.active || state.spraying || state.racing); // state.sideJob / state.racing：計程車救護車段 / 街頭競速段定義的 getter
  const vigCtx = {
    player: { x: 0, z: 0 },
    inPolice: false,
    policeWrecked: false,
    busy: false,
    world: fugitiveWorld,
    earn: (n) => economy.add(n, 'vigilante'),
    toast: (text, seconds) => hud.toast(text, seconds),
    showHint: (id, text) => !!settings.get('showHints') && wantedUI.showHint(id, text),
  };
  const startVigilante = () => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    if (vigilante.canStart({ inPolice: isPoliceCar(v), busy: otherMissionBusy() })) vigilante.start();
  };
  const vigInter = { text: VIG_PROMPT, priority: VIG_PRIORITY, dist: 0, act: startVigilante };
  // 駕駛警車且可開始 → 互動鍵優先給警車任務（回 null 時照常仲裁委託 / 打卡）
  const vigilanteInteractable = (v) => (isPoliceCar(v) && vigilante.canStart({ inPolice: true, busy: otherMissionBusy() }) ? vigInter : null);
  // 暫停 / 全螢幕面板（updateGame 不跑）、手機開著、BUSTED・WASTED、噴漆中、搶劫中：不推進（任務條維持上一幀）、逃犯車煞停（物理照跑）
  const updateVigilante = (dt, skip) => {
    if (skip || !!state.respawn || !!state.spraying || !!robberies.active) {
      fugitiveWorld.brakeAll();
      return;
    }
    const v = state.mode === 'drive' ? state.vehicle : null;
    const p = playerPos();
    vigCtx.player.x = p.x;
    vigCtx.player.z = p.z;
    vigCtx.inPolice = isPoliceCar(v);
    vigCtx.policeWrecked = vigCtx.inPolice && dmg.healthOf(v) === 0;
    vigCtx.busy = otherMissionBusy();
    fugitiveWorld.update(dt);
    const r = vigilante.update(dt, vigCtx);
    vigBar.set(r.text, r.phase === 'running' && r.timeLeft <= VIG_URGENT_SEC);
  };
  // 回主選單 / 開局：無聲結束（逃犯車回收、任務條收起）；須在 cancelRespawn 之前（其 wanted.clear 與任務無關，但保持與搶劫同序）
  const cancelVigilante = () => {
    vigilante.cancel();
    vigBar.set(null);
  };

  // ---------- 超商搶劫（Phase 9，§28）：src/wanted/robbery.js（純邏輯）+ 店員 + 門口小光柱 + 小地圖 / 大地圖標記 ----------
  const robberies = createRobberies({ bus, wanted, police, stores: STORES, rng: Math.random });
  const robberyMarkers = STORES.map((s) => ({ x: s.x, z: s.z, kind: 'store' }));
  const storeBeacons = createBeaconPool({ scene, heightAt, ...STORE_BEACON });
  const storeBeaconOf = new Map(); // store.id → 光柱（只在可搶時持有）
  // 店員：pedestrian 角色換綠制服 + CharacterAnimator + combat actor（clerkOf = 店 id，robbery.js 據 ped:knockdown / ped:dead 判倒地）
  //   + 行人膠囊剛體（kinematic，子彈 / 車撞得到；倒地切 dynamic）。玩家在 CLERK_SPAWN_DIST 內且該店可搶 / 搶劫中（或店員倒地的冷卻中）才存在；
  //   搶完冷卻 = 店員消失；冷卻結束回 ready → 倒地 / 擊斃的店員回收、下一幀重新生成
  const clerks = new Map(); // store.id → { store, pos, yaw, character, mesh, anim, body, actor, settle }
  let clerkSeq = 0;
  pw.onAfterStep((h) => {
    for (const c of clerks.values()) if (c.body && c.body.down) c.settle = c.body.settleCheck(h); // 倒地落穩判定逐子步累計（同警員）
  });
  const placeClerk = (c) => {
    c.mesh.position.set(c.pos.x, c.pos.y + SURFACE_OFFSET, c.pos.z);
    c.mesh.rotation.set(0, c.yaw, 0);
  };
  const spawnClerk = (s) => {
    const character = createCharacter({ variant: 'pedestrian', colors: CLERK_COLORS });
    if (!character) return null;
    const mesh = character.root;
    mesh.rotation.order = 'YXZ';
    const anim = new CharacterAnimator(character, getCharacterManifest()?.clips || []);
    const x = s.counterX;
    const z = s.counterZ;
    const yaw = Number.isFinite(s.clerkYaw) ? s.clerkYaw : 0;
    const c = { store: s, pos: { x, y: heightAt(x, z), z }, yaw, character, mesh, anim, body: null, actor: null, settle: { settled: false, clearToStand: false } };
    c.body = createPedestrianBody(RAPIER, pw, { x, y: c.pos.y, z, yaw }, { groups: GROUPS, router });
    c.body.owner = c; // 子彈 raycast（actorOfCollider）/ 車撞（traffic onVehicleHitPedestrian）以 owner.actor 找到店員
    c.actor = {
      id: `store-clerk-${++clerkSeq}`,
      kind: 'pedestrian',
      faction: 'clerk',
      clerkOf: s.id,
      pos: c.pos,
      yaw,
      hp: CLERK_HP,
      maxHp: CLERK_HP,
      anim,
      recoverOnKo: true,
      body: {
        knockdown: (impulse) => {
          const h = Math.hypot(impulse.x, impulse.z);
          const dir = h > 1e-6 ? { x: impulse.x / h, y: 0, z: impulse.z / h } : { x: -Math.sin(c.yaw), y: 0, z: -Math.cos(c.yaw) };
          c.yaw = Math.atan2(-dir.x, -dir.z); // 面向衝量來向（倒地動作往後躺）
          c.body.hit({ impulse: Math.hypot(impulse.x, impulse.y, impulse.z), dir });
          c.settle = { settled: false, clearToStand: false };
        },
        settleCheck: () => c.settle,
        standUp: () => {
          const p = c.body.recover(c.yaw);
          if (p) {
            c.pos.x = p.x;
            c.pos.y = p.y;
            c.pos.z = p.z;
          }
        },
      },
    };
    combat.register(c.actor);
    scene.add(mesh);
    clerks.set(s.id, c);
    placeClerk(c);
    return c;
  };
  const despawnClerk = (c) => {
    clerks.delete(c.store.id);
    combat.unregister(c.actor);
    c.body.dispose();
    disposeCharacter(c.character);
  };
  const updateClerk = (c, dt) => {
    if (c.body.down) {
      // 倒地：位置跟剛體（角色原點 = 膠囊底部）
      const t = c.body.body.translation();
      c.pos.x = t.x;
      c.pos.y = t.y - c.body.centerY;
      c.pos.z = t.z;
    } else if (!combat.isDown(c.actor)) {
      // 起身後回到櫃檯點、面向門口
      c.pos.x = c.store.counterX;
      c.pos.z = c.store.counterZ;
      c.pos.y = heightAt(c.pos.x, c.pos.z);
      c.yaw = Number.isFinite(c.store.clerkYaw) ? c.store.clerkYaw : 0;
      c.body.setPose(c.pos.x, c.pos.y, c.pos.z, c.yaw);
    }
    c.actor.yaw = c.yaw;
    c.anim.update(dt, { speed: 0 });
    placeClerk(c);
  };
  // 每幀同步：光柱只在可搶時顯示；店員依距離 / 店狀態生成或回收
  const syncStores = (dt, px, pz) => {
    for (const s of robberies.stores) {
      const b = storeBeaconOf.get(s.id);
      if (s.available && !b) storeBeaconOf.set(s.id, storeBeacons.acquire('store', s.x, s.z, s));
      else if (!s.available && b) {
        storeBeacons.release(b);
        storeBeaconOf.delete(s.id);
      }
      const d2 = (px - s.counterX) ** 2 + (pz - s.counterZ) ** 2;
      let c = clerks.get(s.id) || null;
      // 回收：太遠、搶完（店員消失）、已判定死亡、冷卻結束後還是倒地那位
      if (c && (d2 > CLERK_DESPAWN_DIST ** 2 || s.robbed || combat.stateOf(c.actor) === 'dead' || (s.available && (c.body.down || combat.isDown(c.actor))))) {
        despawnClerk(c);
        c = null;
      }
      // 生成：可搶或搶劫中（冷卻結束那一幀 robbery.update 可能已直接開始搶劫）
      if (!c && (s.available || s.state === 'robbing') && state.started && d2 <= CLERK_SPAWN_DIST ** 2) c = spawnClerk(s);
      if (c) updateClerk(c, dt);
    }
    storeBeacons.update(dt);
  };
  // 每幀 ctx（重用）：aiming / aimAt 取 fillAim 填好的 aim（鏡頭中心射線；aim.aiming = 按住瞄準且持手槍，手把 LT 同一路徑）
  const robCtx = {
    player: { x: 0, z: 0, yaw: 0 },
    onFoot: false,
    aiming: false,
    aimAt: (x, z) => aimNear(aim.origin, aim.dir, x, heightAt(x, z) + AIM_HEIGHT, z),
    earn: (n) => economy.add(n, 'robbery'),
    toast: (text, seconds) => hud.toast(text, seconds),
    showHint: (id, text) => !!settings.get('showHints') && wantedUI.showHint(id, text),
  };
  let robShown = false;
  const setRobBar = (r) => {
    if (r && r.active) {
      hud.setRobberyProgress(r.progress, PROGRESS_LABEL);
      robShown = true;
    } else if (robShown) {
      hud.setRobberyProgress(null);
      robShown = false;
    }
  };
  // 暫停 / 全螢幕面板（updateGame 不跑）、手機開著、BUSTED・WASTED、噴漆中：不推進（店員 / 光柱仍同步以 dt 0 擺位）
  const updateRobberies = (dt, skip) => {
    const p = playerPos();
    const frozen = skip || !!state.respawn || !!state.spraying;
    syncStores(frozen ? 0 : dt, p.x, p.z);
    if (frozen) {
      setRobBar(null);
      return;
    }
    robCtx.player.x = p.x;
    robCtx.player.z = p.z;
    robCtx.player.yaw = player.yaw;
    robCtx.onFoot = state.mode === 'walk' && !(state.koTimer > 0 || state.respawn || combat.isDown(player.actor) || vigilante.active); // 倒地 / KO / 送醫中 / 警車任務中不能搶
    if (state.racing) robCtx.onFoot = false; // 街頭競速中（下車 10 s 內）也不能搶（互斥）
    if (state.sideJob) robCtx.onFoot = false; // 計程車 / 救護車副任務中（下車 10 s 內）也不能搶（互斥）
    robCtx.aiming = robCtx.onFoot && aim.aiming;
    setRobBar(robberies.update(dt, robCtx));
  };
  // 回主選單 / 開局：取消進行中的搶劫、店員回收、進度條收起；開新局（resetAll）才重置各店冷卻；須在 cancelRespawn 之前（其 wanted.clear 會中止搶劫並發 robbery:failed）
  const cancelRobbery = (resetAll = false) => {
    robberies.cancel({ resetAll });
    for (const c of [...clerks.values()]) despawnClerk(c);
    setRobBar(null);
  };

  // ---------- 武器店 / 安全屋（Phase 14，src/shops/）----------
  // 武器店：通緝中拒絕交易、扣款走 economy.spend（原子，不足整筆拒扣）、購買 → weapons.give / addAmmo；面板開著 = panelOpen（世界暫停）
  // 安全屋：有星不可進、搶劫中不可進；進入 → 回滿血、wanted.clear('safehouse')、記錄 safehouse.last 後 autosave.flush('safehouse')
  const gunShop = createGunShop({
    bus,
    weapons,
    getMoney: () => economy.money,
    spend: (n, reason) => economy.spend(n, reason),
    getStars: () => wanted.stars,
    beacons: createBeaconPool({ scene, heightAt, ...GUN_SHOP_BEACON }),
    toast: (t, sec) => hud.toast(t, sec),
    doc: document,
    root: document.body,
    keyTarget: window,
  });
  const safehouses = createSafehouses({
    bus,
    getStars: () => wanted.stars,
    beacons: createBeaconPool({ scene, heightAt, ...SAFEHOUSE_BEACON }),
    save: () => autosave.flush('safehouse'),
    heal: () => {
      player.actor.hp = player.actor.maxHp;
    },
    clearWanted: () => wanted.clear('safehouse'),
    toast: (t, sec) => hud.toast(t, sec),
    busy: () => (robberies.active ? '搶劫進行中，不能進安全屋' : null),
  });
  // 每幀（updateStreetEvents 之後）：只推進門口光柱脈動（購買 / 存檔都在互動鍵當下完成）
  const updateShops = (dt) => {
    gunShop.update(dt);
    safehouses.update(dt);
  };
  // 開新局 / 回主選單：關掉武器店面板（closePanels 也會關；此處與其他 cancel* 同列、順序在 cancelRespawn 之前）
  const cancelShops = () => {
    gunShop.cancel();
    safehouses.cancel();
  };

  // ---------- 隱藏包裹（Phase 17）：src/collect/packages.js（純邏輯 + 1 個 InstancedMesh）----------
  const packageMesh = createPackageMesh({ THREE, scene });
  const packages = createPackages({
    bus,
    groundAt: heightAt,
    view: packageMesh,
    earn: (n, reason) => economy.add(n, reason),
    toast: (text, seconds) => hud.toast(text, seconds),
    weapons,
  });
  // 進安全屋（存檔 / 回血之後）：依已達里程碑補給一次（未達 5 個 → 無動作）；實際有給武器 / 補到彈藥才再 autosave.flush('safehouse-resupply')
  //   讓本次補給入檔，存檔結果與補給內容併成同一則 toast（存檔失敗字樣不會被補給訊息蓋掉）；沒補到東西 → 不存檔、不 toast
  bus.on('safehouse:enter', () => {
    if (state.started) packages.resupply({ save: () => autosave.flush('safehouse-resupply') });
  });
  // 每幀（updateStunts 之後）：徒步 = 玩家位置、駕駛 = 車身位置
  const updatePackages = (dt) => {
    packages.update(dt, state.mode === 'drive' && state.vehicle ? state.vehicle.pos : player.pos);
  };
  // 開新局 / 回主選單：動畫歸位（收集狀態由 restore 決定）
  const cancelPackages = () => packages.cancel();

  // ---------- 車流 / 行人外部狀態 ----------
  // 行人大腦：玩家是否在車內、移動中的玩家車（高速逼近會閃避）、玩家 Actor（被拖出的司機還手對象）
  const threat = { x: 0, z: 0, vx: 0, vz: 0 };
  const threats = [];
  const updateTrafficContext = () => {
    threats.length = 0;
    const v = state.mode === 'drive' ? state.vehicle : null;
    if (v) {
      const lv = v.body.body.linvel();
      threat.x = v.pos.x;
      threat.z = v.pos.z;
      threat.vx = lv.x;
      threat.vz = lv.z;
      threats.push(threat);
    }
    traffic.setContext({ playerInVehicle: !!v, vehicles: threats, player: player.actor, lockTarget: null });
    // 路人生活行為（ped-ambient）：時段決定活動比例；步行持槍瞄準時，瞄準方向上 10 m 內的路人抱頭蹲下
    ambientCtx.hour = dayNight.hour;
    ambientCtx.aiming = aim.aiming && state.mode !== 'drive';
    ambientCtx.aimDirX = aim.dir.x;
    ambientCtx.aimDirZ = aim.dir.z;
    if (traffic.ambient) traffic.ambient.setContext(ambientCtx);
  };
  const ambientCtx = { hour: 12, aiming: false, aimDirX: 0, aimDirZ: 1 };

  // ---------- 計程車 / 救護車副任務（Phase 13，§35）：src/missions/taxi.js / ems.js（純邏輯 + 路邊行人世界 + 任務條）+ 目的地光柱 + 小地圖標記 ----------
  const taxi = createTaxi({ bus, rng: Math.random });
  const ems = createEms({ bus, rng: Math.random });
  // 招手乘客 / 倒地傷患：徵用玩家附近漫步中的路人（brain.override / combat.knockdownActor），上車 = traffic._recyclePed（人消失於車內）
  const curbPeds = createCurbPedWorld({ traffic, combat, rng: Math.random, getPlayer: () => playerPos() });
  const taxiBar = createSideJobBar({ root: document.body, prefix: 'taxi' });
  const emsBar = createSideJobBar({ root: document.body, prefix: 'ems' });
  const sideJobBeacons = createBeaconPool({ scene, heightAt, ...SIDEJOB_BEACON });
  // 救護車外觀：既有 suv 白車 + 兩側紅條 + 車頂紅 / 藍燈（共用單位方塊幾何、無貼圖材質；不投影、不加光源 → 不多吃貼圖單元）
  const ambBox = new THREE.BoxGeometry(1, 1, 1);
  const ambStripeMat = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.6 });
  const ambLightMats = [
    new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1a1a, emissiveIntensity: 0.15 }),
    new THREE.MeshStandardMaterial({ color: 0x00105a, emissive: 0x2a5cff, emissiveIntensity: 0.15 }),
  ];
  const decorateAmbulance = (v) => {
    const root = v.mesh;
    if (!root || root.getObjectByName('ems-decor')) return;
    const g = new THREE.Group();
    g.name = 'ems-decor';
    g.scale.set(1 / (root.scale.x || 1), 1 / (root.scale.y || 1), 1 / (root.scale.z || 1)); // glb 根節點有縮放時維持公尺尺寸
    const { length: L, width: W, height: H } = v.spec;
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(ambBox, ambStripeMat);
      m.scale.set(0.03, 0.24, L * 0.86);
      m.position.set(s * (W / 2 + 0.02), H * 0.48, 0);
      g.add(m);
    }
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(ambBox, ambLightMats[i]);
      m.scale.set(0.42, 0.14, 0.26);
      m.position.set(i ? 0.25 : -0.25, H + 0.07, -0.15);
      g.add(m);
    }
    root.add(g);
  };
  const ambulances = createAmbulanceDepot({
    vehicles, dmg, spot: ambulanceSpot(), decorate: decorateAmbulance,
    isBusy: (v) => v === state.vehicle || v === cj.vehicle || v === emsCar,
  });
  // 互斥旗標：警車任務段的 otherMissionBusy、搶劫守門、委託 nearestInteractable 讀 state.sideJob（getter，不另存狀態）
  Object.defineProperty(state, 'sideJob', { get: () => taxi.active || ems.active, enumerable: true, configurable: true });
  // vigHooks.active（委託 / 外送 / 垃圾車 / 打工 extraBusy、噴漆廠入口）/ vigHooks.end（BUSTED / WASTED）併入副任務
  const vigActiveSide = vigHooks.active;
  vigHooks.active = () => vigActiveSide() || taxi.active || ems.active;
  const vigEndSide = vigHooks.end;
  vigHooks.end = (kind) => {
    vigEndSide(kind);
    taxi.end(kind);
    ems.end(kind);
    taxiBar.set(null);
    emsBar.set(null);
  };
  const sideMk = [];
  const sideJobMarkers = () => {
    sideMk.length = 0;
    taxi.markers(sideMk);
    return ems.markers(sideMk);
  };
  const isTaxiCar = (v) => !!v && v.type === 'taxi';
  let taxiCar = null; // 開始 / 任務中駕駛的計程車（耐久歸零 = 車毀結束）
  let emsCar = null;
  const taxiCtx = {
    player: { x: 0, z: 0 },
    inTaxi: false,
    car: null,
    speed: 0,
    health: null,
    maxHealth: null,
    wrecked: false,
    world: curbPeds,
    earn: (n) => economy.add(n, 'taxi'),
    toast: (text, seconds) => hud.toast(text, seconds),
    routeLength: (a, b) => {
      const r = findRoute(graph, a, b);
      return r ? r.lengthM : null;
    },
  };
  const emsCtx = {
    player: { x: 0, z: 0 },
    inAmbulance: false,
    speed: 0,
    wrecked: false,
    world: curbPeds,
    earn: (n) => economy.add(n, 'ems'),
    heal: () => {
      player.actor.hp = player.actor.maxHp;
    },
    toast: (text, seconds) => hud.toast(text, seconds),
  };
  const sideBusy = () => otherMissionBusy() || vigilante.active;
  const startCtx = { inTaxi: false, inAmbulance: false, busy: false, stalled: false, overturned: false, toast: taxiCtx.toast };
  const toggleSideJob = () => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    if (!v) return;
    if (taxi.active || ems.active) {
      if (taxi.active) taxi.end('quit', taxiCtx);
      else ems.end('quit', emsCtx);
      return;
    }
    startCtx.inTaxi = isTaxiCar(v);
    startCtx.inAmbulance = ambulances.isAmbulance(v);
    startCtx.busy = sideBusy();
    startCtx.stalled = dmg.healthOf(v) === 0;
    startCtx.overturned = !!v.fallen || v.isOverturned();
    if (startCtx.inTaxi && taxi.start(startCtx)) taxiCar = v;
    else if (startCtx.inAmbulance && ems.start(startCtx)) emsCar = v;
  };
  const sideInter = { text: '', priority: SIDEJOB_PRIORITY, dist: 0, act: toggleSideJob };
  // 駕駛計程車 / 救護車：未開始 → 開始提示（其他任務中回 null）；進行中 → 收工提示
  const sideJobInteractable = (v) => {
    if (!v || state.respawn) return null;
    const isTaxi = isTaxiCar(v);
    const isAmb = ambulances.isAmbulance(v);
    if (!isTaxi && !isAmb) return null;
    if (taxi.active) sideInter.text = isTaxi ? TAXI_PROMPT_QUIT : null;
    else if (ems.active) sideInter.text = isAmb ? EMS_PROMPT_QUIT : null;
    else sideInter.text = sideBusy() ? null : isTaxi ? TAXI_PROMPT_START : EMS_PROMPT_START;
    return sideInter.text ? sideInter : null;
  };
  // 光柱：計程車目的地 / 送醫中的醫院（換點時重放）
  let sideBeaconAt = null;
  const syncSideJobBeacons = (dt) => {
    const d = taxi.beacons().dest || ems.beacons().dest;
    if (d !== sideBeaconAt) {
      sideJobBeacons.releaseAll();
      if (d) sideJobBeacons.acquire(taxi.active ? 'taxi' : 'ems', d.x, d.z, d);
      sideBeaconAt = d;
    }
    sideJobBeacons.update(dt);
  };
  // 頂燈：救護車任務中紅藍交替（只在切換時改 emissiveIntensity），否則暗
  let ambFlashT = 0;
  let ambFlashState = -1;
  const flashAmbulance = (dt) => {
    ambFlashT = (ambFlashT + dt) % (AMB_FLASH_SEC * 2);
    const st = ems.active ? (ambFlashT < AMB_FLASH_SEC ? 1 : 2) : 0;
    if (st === ambFlashState) return;
    ambFlashState = st;
    ambLightMats[0].emissiveIntensity = st === 1 ? 2.4 : 0.15;
    ambLightMats[1].emissiveIntensity = st === 2 ? 2.4 : 0.15;
  };
  // 手機 / 暫停 / 全螢幕面板（updateGame 不跑）、BUSTED・WASTED、噴漆中：不推進（計時停、任務條維持）；
  // 但世界照跑（combat 會推進起身）→ 傷患倒地計時照常刷新（curbPeds.update 不跳過）
  const updateSideJobs = (dt, skip) => {
    const p = playerPos();
    curbPeds.update(dt);
    if (skip || !!state.respawn || !!state.spraying) {
      syncSideJobBeacons(0);
      return;
    }
    ambulances.update(dt, p);
    const v = state.mode === 'drive' ? state.vehicle : null;
    const speed = v ? v.speed || 0 : 0;
    if (taxi.active) {
      // 載客中以上車那台車為準：換開別台計程車 = 不在車上（taxi.js 比對 ctx.car；耐久只讀上車那台）
      const inTaxi = isTaxiCar(v) && (taxi.phase !== 'ride' || v === taxiCar);
      if (inTaxi) taxiCar = v;
      taxiCtx.player.x = p.x;
      taxiCtx.player.z = p.z;
      taxiCtx.inTaxi = inTaxi;
      taxiCtx.car = isTaxiCar(v) ? v : null;
      taxiCtx.speed = speed;
      taxiCtx.health = inTaxi ? dmg.healthOf(v) : null;
      taxiCtx.maxHealth = inTaxi ? dmg.maxHealthOf(v) : null;
      taxiCtx.wrecked = !!taxiCar && dmg.healthOf(taxiCar) === 0;
    }
    const t = taxi.update(dt, taxiCtx);
    if (!t.active) taxiCar = null;
    taxiBar.set(t.text, t.urgent);
    if (ems.active) {
      const inAmb = ambulances.isAmbulance(v);
      if (inAmb) emsCar = v;
      emsCtx.player.x = p.x;
      emsCtx.player.z = p.z;
      emsCtx.inAmbulance = inAmb;
      emsCtx.speed = speed;
      emsCtx.wrecked = !!emsCar && dmg.healthOf(emsCar) === 0;
    }
    const e = ems.update(dt, emsCtx);
    if (!e.active) emsCar = null;
    emsBar.set(e.text, e.urgent);
    flashAmbulance(dt);
    syncSideJobBeacons(dt);
  };
  // 回主選單 / 開局：無聲結束（乘客 / 傷患交還、任務條收起、光柱收起）
  const cancelSideJobs = () => {
    taxi.cancel();
    ems.cancel();
    curbPeds.dispose(); // 保底：殘留 handle 一律交還（解除 override / pinned），live 清空
    taxiCar = null;
    emsCar = null;
    taxiCtx.car = null;
    taxiBar.set(null);
    emsBar.set(null);
    flashAmbulance(0); // 頂燈轉暗（選單巡覽 / BUSTED 畫面不會跑 updateSideJobs）
    syncSideJobBeacons(0);
  };

  // ---------- 街頭競速（Phase 12，§34）：src/missions/race.js（純邏輯 + 對手車世界介面 + HUD）+ 起點 / 檢查點光柱 + 小地圖旗幟 ----------
  const races = createRaces({ bus, rng: Math.random });
  // 對手車：一般動態剛體車（會被撞、會撞車流車）；回收時保留玩家正駕駛 / 上車 / 搶車中的車，併入 adopted
  const rivalWorld = createRivalWorld({
    vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng: Math.random,
    isFree: (x, z) => !buildingAt(x, z, RACE_SPAWN_PAD),
    isKept: (v) => v === state.vehicle || v === cj.vehicle,
    onKeep: (v) => adopted.add(v),
  });
  const raceHud = createRaceHud({ root: document.body });
  const raceStartBeacons = createBeaconPool({ scene, heightAt });
  const raceCpBeacons = createBeaconPool({ scene, heightAt, ...RACE_CP_BEACON });
  // 互斥旗標：警車任務段的 otherMissionBusy、搶劫守門讀 state.racing（getter，不另存狀態）
  Object.defineProperty(state, 'racing', { get: () => races.active, enumerable: true, configurable: true });
  // vigHooks.active = 「排他任務進行中」（委託 / 外送 / 垃圾車 / 打工 extraBusy、噴漆廠入口）：併入競速
  const vigActiveHook = vigHooks.active;
  vigHooks.active = () => vigActiveHook() || races.active;
  // BUSTED / WASTED：beginRespawn → vigHooks.end(kind) → 退賽（races 另訂閱 player:busted / player:wasted 保底）
  const vigEndHook = vigHooks.end;
  vigHooks.end = (kind) => {
    vigEndHook(kind);
    races.end(kind);
    raceHud.set(null);
  };
  const raceMk = [];
  const raceMarkers = () => {
    raceMk.length = 0;
    return races.markers(raceMk);
  };
  let raceCar = null; // 開賽 / 比賽中駕駛的車（耐久歸零 = 車毀退賽）
  const raceCtx = {
    player: { x: 0, z: 0 },
    inCar: false,
    wrecked: false,
    world: rivalWorld,
    earn: (n) => economy.add(n, 'race'),
    toast: (text, seconds) => hud.toast(text, seconds),
  };
  const raceBusy = () => otherMissionBusy() || vigilante.active;
  const startRace = (id) => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    const p = playerPos();
    // 熄火 / 翻車 / 未停車（車速 ≥ START_MAX_SPEED）→ races.start toast 不開賽
    const car = v ? { speed: v.speed || 0, stalled: dmg.healthOf(v) === 0, overturned: !!v.fallen || v.isOverturned() } : {};
    if (races.start(id, { inCar: !!v, player: { x: p.x, z: p.z }, stars: wanted.stars, busy: raceBusy(), toast: raceCtx.toast, ...car })) raceCar = v;
  };
  const raceInter = { text: '', priority: RACE_PRIORITY, dist: 0, raceId: null, act: () => startRace(raceInter.raceId) };
  // 駕車在某賽道起點光柱內、未開賽、無其他任務 → 互動提示（有星數仍顯示，按下 toast 提示不開賽）
  const raceInteractable = (v) => {
    if (!v || races.active || state.respawn || raceBusy()) return null;
    const def = races.nearestStart(v.pos.x, v.pos.z);
    if (!def) return null;
    raceInter.text = racePromptText(def);
    raceInter.raceId = def.id;
    return raceInter;
  };
  // 光柱：未開賽 → 各起點橘色光柱；比賽中 → 下一個檢查點大光柱圈（換點時重放）
  const raceBeaconAt = { start: false, cp: null };
  const syncRaceBeacons = (dt) => {
    const b = races.beacons();
    const wantStarts = b.starts.length > 0;
    if (wantStarts !== raceBeaconAt.start) {
      raceStartBeacons.releaseAll();
      if (wantStarts) for (const s of b.starts) raceStartBeacons.acquire('race', s.x, s.z, s);
      raceBeaconAt.start = wantStarts;
    }
    if (b.checkpoint !== raceBeaconAt.cp) {
      raceCpBeacons.releaseAll();
      if (b.checkpoint) raceCpBeacons.acquire('race', b.checkpoint.x, b.checkpoint.z, b.checkpoint);
      raceBeaconAt.cp = b.checkpoint;
    }
    raceStartBeacons.update(dt);
    raceCpBeacons.update(dt);
  };
  // 暫停 / 全螢幕面板（updateGame 不跑）、手機開著、BUSTED・WASTED、噴漆中、搶劫中、警車任務中：不推進（計時停、HUD 維持）、對手車煞停
  const updateRace = (dt, skip) => {
    if (skip || !!state.respawn || !!state.spraying || !!robberies.active || vigilante.active) {
      rivalWorld.brakeAll();
      syncRaceBeacons(0);
      return;
    }
    const v = state.mode === 'drive' ? state.vehicle : null;
    if (v && races.active) raceCar = v;
    const p = playerPos();
    raceCtx.player.x = p.x;
    raceCtx.player.z = p.z;
    raceCtx.inCar = !!v;
    raceCtx.wrecked = !!raceCar && dmg.healthOf(raceCar) === 0;
    rivalWorld.update(dt);
    const r = races.update(dt, raceCtx);
    if (!r.active) raceCar = null;
    const yaw = v ? v.yaw : player.yaw;
    raceHud.set(r, r.next ? raceArrowAngle(p.x, p.z, yaw, r.next.x, r.next.z) : 0);
    syncRaceBeacons(dt);
  };
  // 回主選單 / 開局：無聲退賽（對手車回收、HUD 收起、光柱回起點）
  const cancelRace = () => {
    races.cancel();
    raceCar = null;
    raceHud.set(null);
    syncRaceBeacons(0);
  };

  // ---------- V2 幫派地盤（src/gangs.js，純邏輯）+ 幫派車（createGangCars：一般車型換幫派車色、前座兩名幫派配色乘客）----------
  // 每幀 updateGangs（updateVigilante 之後）；暫停 / 全螢幕面板（updateGame 不跑）、手機、BUSTED・WASTED、噴漆中 → frozen（成員停手、幫派車煞停）
  // 開新局 / 回主選單 → gangs.cancel()；被捕 / 送醫由 gangs 自己訂閱 player:busted / player:wasted 歸零（finishRespawn 發；畫面期間 frozen）
  // 生成點避開玩家視線（同警車 canSee）；被搶 / 正上車的幫派車交還一般車輛併入 adopted（玩家離開後遠了照一般搶來車回收），熄火殘骸由 cleanupVehicles 照報廢車回收
  const gangCars = createGangCars({
    vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng: Math.random, seatHips: SEAT_HIPS_HEIGHT,
    characters: { createCharacter, disposeCharacter, CharacterAnimator, clips: getCharacterManifest()?.clips || [] },
    canSee: (ax, az, bx, bz) => policeAdapters.canSee(ax, az, bx, bz),
    isKept: (v) => v === state.vehicle || v === cj.vehicle,
    onKeep: (v) => adopted.add(v),
  });
  const gangPlayer = { x: 0, z: 0, actor: player.actor, inVehicle: false, aiming: false, aimDirX: 0, aimDirZ: 1, disabled: false };
  const gangCtx = {
    frozen: false,
    combat,
    cars: gangCars,
    player: gangPlayer,
    damageVehicle: (n) => (state.mode === 'drive' && state.vehicle ? dmg.addDamage(state.vehicle, n) : 0),
  };
  // 車內中彈 / 被炸 hp 歸零：handleCarKo（updateGangs 結尾、updateExplosions 之後各一次）強制下車倒地
  // （knockdownActor emit → 既有 combat 'knockdown' → player:ko → WASTED）；同一幀已按 F 下車（walk）也照樣倒地
  let gangCarKo = null; // null | 倒地 cause
  combat.on('hit', (e) => {
    if (e.inVehicle && e.target === player.actor && player.actor.hp <= 0) gangCarKo = e.weapon === 'explosion' ? 'explosion' : 'bullet';
  });
  const handleCarKo = () => {
    if (!gangCarKo) return;
    const cause = gangCarKo;
    gangCarKo = null;
    if (state.respawn || state.koTimer > 0 || player.actor.hp > 0) return;
    if (state.mode === 'drive') exitVehicle(true);
    combat.knockdownActor(player.actor, { cause, emit: true });
  };
  const updateGangs = (dt, skip) => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    const p = playerPos();
    gangPlayer.x = p.x;
    gangPlayer.z = p.z;
    gangPlayer.inVehicle = !!v;
    gangPlayer.aiming = !v && aim.aiming;
    gangPlayer.aimDirX = aim.dir.x;
    gangPlayer.aimDirZ = aim.dir.z;
    gangPlayer.disabled = state.koTimer > 0 || !!state.respawn || combat.isDown(player.actor);
    gangCtx.frozen = skip || !!state.respawn || !!state.spraying;
    gangs.update(dt, gangCtx);
    handleCarKo();
  };
  bus.on('gang:enter', (e) => {
    if (state.started && e) hud.toast(`⚠ 進入${e.name}地盤`, 3);
  });
  bus.on('gang:hostile', (e) => {
    if (state.started && e && e.hostile) hud.toast(`${e.name}盯上你了！`, 3);
  });
  bus.on('gang:driveby', (e) => {
    if (state.started && e && e.phase === 'start') hud.toast(`${e.name}開車來找你了！`, 3);
  });

  // ---------- V4 車輛起火爆炸（src/explosions.js；介面見 docs/dev/interfaces.md §31）----------
  // 耐久沿用 dmg（vehicle-damage.js）；車流車平時不 attach，第一次被槍擊 / 爆炸波及時才 dmg.attach（trafficDamaged，回收時 detach）
  const trafficDamaged = new Set();
  const trafficCarOfVehicle = (v) => {
    for (const c of traffic.cars) if (c.v === v) return c;
    return null;
  };
  const ensureDamageable = (v) => {
    if (dmg.healthOf(v) !== null) return true;
    if (!trafficCarOfVehicle(v)) return false;
    dmg.attach(v);
    trafficDamaged.add(v);
    return true;
  };
  const blastVehicles = []; // 範圍效果候選（重用）：VehicleManager 的車 + 啟用中的車流車
  const explosionImpulse = createExplosionImpulse({ RAPIER, pw, router, groups: queryGroups(G_VEHICLE | G_NPC_CAR | G_DEBRIS), flags: QF_NO_SENSOR });
  const explosions = createExplosions({
    THREE,
    scene,
    bus,
    combat,
    physics: explosionImpulse,
    config: {
      healthOf: (v) => dmg.healthOf(v),
      maxHealthOf: (v) => dmg.maxHealthOf(v),
      addDamage: (v, n) => (ensureDamageable(v) ? dmg.addDamage(v, n) : 0),
      vehicles: () => {
        blastVehicles.length = 0;
        for (const v of vehicles.vehicles) blastVehicles.push(v);
        for (const c of traffic.cars) if (c.body.active) blastVehicles.push(c.v);
        return blastVehicles;
      },
      // 殘骸：車流車轉成殘骸剛體（dynamic、不再交還車道，遠了照 traffic 回收）；玩家正在開的車由車內 hp 歸零流程（gangCarKo）下車
      onWreck: (v) => {
        // 停用中（ACTIVE_RADIUS 外）的剛體 hit 不受理：先啟用再轉殘骸（traffic 另以 v.burnt 停駛 / 不給搶）
        const c = trafficCarOfVehicle(v);
        if (c && !c.body.isWrecked) {
          if (!c.body.active) c.body.setActive(true);
          c.body.hit({ impulse: NPC_WRECK_IMPULSE * 1.5, dir: { x: 0, y: 1, z: 0 } });
        }
      },
      quality: () => tier,
      pointScale: () => renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
      rng: Math.random,
    },
  });
  // 玩家槍擊車輛：weapon:impact 帶 vehicle（main.js raycast → aim.js → weapons.js）→ 車輛損壞（約 25 發起火）
  bus.on('weapon:impact', (e) => {
    if (!e || !e.vehicle || !(e.damage > 0)) return;
    explosions.damageVehicle(e.vehicle, e.damage, { source: e.byPlayer ? player.actor : null });
  });
  // 玩家駕駛撞到起火 / 爆炸：記為玩家造成——只在 impact() 由玩家駕駛的碰撞設定（別人打 / 炸玩家的車不算玩家）
  blastSource = explosions.setSource;
  bus.on('vehicle:fire', (e) => {
    if (e && byPlayer(e.vehicle)) hud.toast('🔥 車子起火了！快按 F 下車！', 3);
  });
  // 鏡頭震動：依鏡頭到爆炸點的距離換算 trauma；手把同步震動
  bus.on('explosion:shake', (e) => {
    const k = shakeTrauma(Math.hypot(camera.position.x - e.x, camera.position.y - e.y, camera.position.z - e.z), e.radius, e.power);
    if (!(k > 0)) return;
    rig.shake(k);
    gamepad.rumble(k, k, 200 + 400 * k);
  });
  // 爆炸聲驚嚇：45 m 內行人 hear（同槍聲反應）
  const boomEvt = { type: 'gunshot', x: 0, z: 0 };
  bus.on('explosion', (e) => {
    boomEvt.x = e.x;
    boomEvt.z = e.z;
    for (const b of traffic.brains.values()) {
      const p = b && b.actor && b.actor.pos;
      if (p && (p.x - e.x) ** 2 + (p.z - e.z) ** 2 <= EXPLOSION_HEAR_RADIUS * EXPLOSION_HEAR_RADIUS) b.hear(boomEvt);
    }
  });
  // 通緝：爆炸致死 / 傷人走既有 ped:dead（cause 'explosion' → kill / killPolice）與 combat:hit（assault）；炸警車 = policeVehicle
  bus.on('vehicle:explode', (e) => {
    if (!e || !e.byPlayer || !isPoliceCar(e.vehicle) || stolenPolice.has(e.vehicle)) return;
    // 帶被炸的車：街頭事件豁免只限罪犯車本身（shotAtEvent 比對命中車），罪犯車旁被炸的警車照算；警車任務沿用落點判定
    if (vigHooks.fugitiveShot(e.x, e.z, e.vehicle)) return;
    reportCrime(CRIMES.policeVehicle, e.x, e.z);
  });
  // 每幀：引信吃模擬時間（worldStep.simDt），粒子 / 閃光吃渲染 dt；殘骸車流車被 traffic 回收後 detach
  let explodeScanT = 0;
  const updateExplosions = (dt) => {
    explosions.update(dt, worldStep.simDt, focus.x, focus.z);
    explodeScanT += dt;
    if (explodeScanT < CLEANUP_SEC) return;
    explodeScanT = 0;
    for (const v of trafficDamaged) {
      if (trafficCarOfVehicle(v)) continue;
      dmg.detach(v);
      explosions.forget(v);
      trafficDamaged.delete(v);
    }
  };
  const clearExplosions = () => explosions.clear();

  // ---------- V5 警方升級（罪惡之都；介面見 docs/dev/interfaces.md §33）：直升機 src/wanted/helicopter.js；路障 / 特警在 police.js + adapters.js ----------
  // 避障高度場：地面與建築碰撞體頂（buildings.colliders：base + h，地標替換建築已用模型高）取高，
  //   地標 glb 另用 LANDMARK_SOLIDS 分層量體（含伸出 OSM 輪廓外的部分）；直升機以機身圓盤 + 前方取樣取最大值
  const heliObstacleTop = createHeliObstacleTop({ heightAt, solids: buildings.colliders });
  const heli = createHelicopter({
    THREE,
    scene,
    bus,
    wanted,
    combat,
    heightAt,
    obstacleTop: heliObstacleTop,
    explode: (x, y, z, { byPlayer, radius, power }) => explosions.explode(x, y, z, { radius, power, source: byPlayer ? player.actor : null }),
    damageVehicle: (n) => (state.mode === 'drive' && state.vehicle ? dmg.addDamage(state.vehicle, n) : 0),
    getPlayerActor: () => player.actor,
    isNight: () => dayNight.night,
    quality: () => tier,
    rng: Math.random,
  });
  const heliCtx = { player: null, paused: false };
  // updateWanted 內呼叫（暫停 / 全螢幕面板 / 手機開著時 updateWanted 不跑 = 凍結）；噴漆換色、BUSTED / WASTED 期間 paused（不推進、不開槍）
  policeV5.update = (dt, pl) => {
    heliCtx.player = pl;
    heliCtx.paused = !!state.spraying || !!state.respawn;
    return heli.update(dt, heliCtx);
  };
  // 開新局 / 回主選單：直升機立即收起、路障與特警立即回收（一般警力照 Phase 7 由 wanted.clear 逐步回收）
  policeV5.cancel = () => {
    heli.cancel();
    police.cancelExtras();
  };
  // 打下直升機 = 襲警致死（警方當然知道是誰）；首次出動 / 路障 / 特警出提示
  bus.on('police:heli', (e) => {
    if (!e) return;
    if (e.type === 'down' && e.byPlayer) wanted.report(CRIMES.killPolice, { x: e.x, z: e.z, witnessed: true });
    if (e.type === 'arrive' && settings.get('showHints')) wantedUI.showHint('heli', '🚁 警用直升機出動！被探照燈光圈照到就會被看見——高速甩開光圈，或用手槍把它打下來。');
  });
  bus.on('police:roadblock', (e) => {
    if (e && e.type === 'spawn' && settings.get('showHints')) wantedUI.showHint('roadblock', '🚧 前方路口有警方路障！換條路，或高速撞開警車。');
  });
  bus.on('police:swat', (e) => {
    if (e && e.type === 'spawn') hud.toast('⚠️ 特警出動！', 2.5);
  });

  // ---------- V3 街頭隨機犯罪事件（src/street-events.js；介面見 docs/dev/interfaces.md §32）----------
  // 純邏輯排程 createStreetEvents + 世界轉接 createStreetWorld：搶劫 / 槍戰徵用附近骨架行人（brain.override）、追車 / 酒駕 = vehicles.adopt 事件車，
  // 追車警車走既有 policeAdapters（spawnCar / driveCar / despawnCar；不經 police.js，0 星不追玩家）、槍戰走 gangs.skirmish（成員換色掛槍）
  const streetEvents = createStreetEvents({ bus, rng: Math.random });
  const streetPlayer = { x: 0, z: 0, actor: player.actor, inVehicle: false };
  const streetWorld = createStreetWorld({
    traffic, combat, vehicles, dmg, findRoute: (a, b) => findRoute(graph, a, b), police: policeAdapters, gangs, bus, rng: Math.random,
    repaint: (p) => {
      repaintCharacter(p.character, p.citizen.look);
      p.look = p.citizen.look;
      traffic._gangWeapon(p, p.citizen.gang ? p.citizen.gang.weapon : null);
    },
    canSee: (ax, az, bx, bz) => policeAdapters.canSee(ax, az, bx, bz),
    getPlayer: () => {
      const p = playerPos();
      streetPlayer.x = p.x;
      streetPlayer.z = p.z;
      streetPlayer.inVehicle = state.mode === 'drive';
      return streetPlayer;
    },
    isKept: (v) => v === state.vehicle || v === cj.vehicle,
    onKeep: (v) => adopted.add(v),
  });
  // 犯行豁免：事件歹徒（搶匪 / 下車罪犯 / 槍戰成員；以 actor.id 比對，骨架回池換人不沿用）與打中罪犯車 / 酒駕車本身（weapon:fire.vehicle）；
  // 誤傷路人 / 警察（含落點在罪犯車旁）照既有規則算
  const vigActorHook = vigHooks.fugitiveActor;
  const vigShotHook = vigHooks.fugitiveShot;
  vigHooks.fugitiveActor = (a) => vigActorHook(a) || streetEvents.isEventActor(a);
  vigHooks.fugitiveShot = (x, z, v) => vigShotHook(x, z) || streetEvents.shotAtEvent(x, z, v);
  // 賞金歸屬：玩家駕駛的車撞到事件車 → 記為玩家出手（射中事件車走 weapon:impact，street-events 自行訂閱）；只是在旁邊不給賞金
  router.onVehicleHitVehicle(({ a, b }) => {
    const va = a && a.owner;
    const vb = b && b.owner;
    if (va && byPlayer(va)) streetEvents.vehicleHitByPlayer(vb);
    else if (vb && byPlayer(vb)) streetEvents.vehicleHitByPlayer(va);
  });
  const streetMarkerBuf = [];
  const streetMarkers = () => {
    streetMarkerBuf.length = 0;
    return streetEvents.markers(streetMarkerBuf);
  };
  const streetCtx = {
    player: { x: 0, z: 0 },
    view: null,
    hour: 12,
    busy: false,
    world: streetWorld,
    earn: (n) => economy.add(n, 'street'),
    toast: (text, seconds) => hud.toast(text, seconds),
  };
  // 每幀（updateExplosions 之後）：手機 / BUSTED・WASTED / 噴漆 → 凍結（事件車煞停、計時不前進）；
  // 搶劫 / 警車任務 / 委託 / 外送 / 打工進行中 → busy（不生成新事件，既有事件照常收尾）；暫停 / 全螢幕面板時 updateGame 不跑
  const updateStreetEvents = (dt, skip) => {
    const frozen = skip || !!state.respawn || !!state.spraying;
    streetWorld.update(dt, frozen);
    const p = playerPos();
    streetCtx.player.x = p.x;
    streetCtx.player.z = p.z;
    streetCtx.view = traffic.view;
    streetCtx.hour = dayNight.hour;
    streetCtx.busy = frozen || !!robberies.active || vigilante.active || otherMissionBusy();
    streetEvents.update(frozen ? 0 : dt, streetCtx);
  };
  // 開新局 / 回主選單：無聲收尾（參與者 / 事件車回收、排程重置）；已結束仍在離場的事件車 / 收隊警車 / 待回收行人也一併清掉（零殘留）
  const cancelStreetEvents = () => {
    streetEvents.cancel();
    streetWorld.reset();
  };

  // ---------- 暴走任務（Phase 15，§37）：src/missions/rampage.js（純邏輯 + 補敵人世界介面 + HUD + 骷髏標記）----------
  // 擊殺只算目標幫派成員（gangs.gangOf）；炸車只算玩家弄爆、且不是玩家正駕駛的車；暫發 / 恢復武器在 rampage.js 內（weapons.serialize 快照）
  const rampage = createRampage({ bus, weapons, gangOf: (a) => gangs.gangOf(a), isTargetVehicle: (v) => !!v && v !== state.vehicle });
  const rampageWorld = createRampageWorld({
    traffic, gangs, combat,
    repaint: (p) => {
      repaintCharacter(p.character, p.citizen.look);
      p.look = p.citizen.look;
      traffic._gangWeapon(p, p.citizen.gang ? p.citizen.gang.weapon : null);
    },
  });
  const rampageHud = createRampageHud({ root: document.body });
  const rampageSkulls = createSkullMarkers({ THREE, scene, heightAt });
  // 互斥旗標：state.rampage（getter）；otherMissionBusy（警車任務 / 競速 / 副任務 / 街頭事件）與搶劫守門讀 state.racing（字串由 P12 / P13 測試鎖定）
  //   → 包裝既有 racing getter 併入暴走（不改 otherMissionBusy 原文）
  Object.defineProperty(state, 'rampage', { get: () => rampage.active, enumerable: true, configurable: true });
  const racingGet = Object.getOwnPropertyDescriptor(state, 'racing').get;
  Object.defineProperty(state, 'racing', { get: () => racingGet() || rampage.active, enumerable: true, configurable: true });
  // vigHooks.active（委託 / 外送 / 垃圾車 / 打工 extraBusy、噴漆廠入口）/ vigHooks.end（BUSTED / WASTED → 暴走失敗、恢復武器）
  const vigActiveRampage = vigHooks.active;
  vigHooks.active = () => vigActiveRampage() || rampage.active;
  const vigEndRampage = vigHooks.end;
  vigHooks.end = (kind) => {
    vigEndRampage(kind);
    rampage.end(kind);
    rampageHud.set(null);
  };
  const rampageMk = [];
  const rampageMarkers = () => {
    rampageMk.length = 0;
    return rampage.markers(rampageMk);
  };
  const rampageBusy = () => otherMissionBusy() || vigilante.active || !!state.respawn || !!state.spraying;
  const rampageCtx = {
    player: { x: 0, z: 0 },
    onFoot: false,
    busy: false,
    frozen: false,
    world: rampageWorld,
    earn: (n) => economy.add(n, 'rampage'),
    toast: (text, seconds) => hud.toast(text, seconds),
  };
  // 每幀（updateShops 之後）：手機 / BUSTED・WASTED / 噴漆 → frozen（計時停、不觸發、不補敵人；HUD 維持）；暫停 / 全螢幕面板時 updateGame 不跑
  const updateRampage = (dt, skip) => {
    const p = playerPos();
    rampageCtx.player.x = p.x;
    rampageCtx.player.z = p.z;
    rampageCtx.frozen = skip || !!state.respawn || !!state.spraying;
    rampageCtx.onFoot = state.mode === 'walk' && !(state.koTimer > 0) && !combat.isDown(player.actor);
    rampageCtx.busy = !rampage.active && rampageBusy();
    rampageHud.set(rampage.update(dt, rampageCtx));
    rampageSkulls.update(rampageCtx.frozen ? 0 : dt, rampage);
  };
  // 開新局 / 回主選單：無聲失敗（恢復開始前的武器、HUD 收起）
  const cancelRampage = () => {
    rampage.cancel();
    rampageHud.set(null);
    rampageSkulls.update(0, rampage);
  };

  // 車流停車判斷用：玩家（或玩家的車）與路邊車輛
  const blockers = [];
  const collectBlockers = () => {
    blockers.length = 0;
    if (state.started) blockers.push(state.mode === 'drive' ? state.vehicle.pos : player.pos);
    for (const v of vehicles.vehicles) blockers.push(v.pos);
    return blockers;
  };

  // 行人補生成的視野：鏡頭位置、水平朝向、水平視角半角（上一幀的鏡頭）
  const viewDir = new THREE.Vector3();
  const updateTrafficView = () => {
    camera.getWorldDirection(viewDir);
    const h = Math.hypot(viewDir.x, viewDir.z) || 1;
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    traffic.setView(camera.position.x, camera.position.z, viewDir.x / h, viewDir.z / h, halfH);
  };

  // 物理一幀（順序見 core/loop.js createWorldStep）：step（內含固定子步；號誌相位 / 耐久去重時鐘在子步內推進）→ 號誌燈色 → 對抗 → 插值同步 → 耐久 / 煙 → 車輛遠距簡化（ACTIVE_RADIUS）
  const worldStep = createWorldStep({
    pw, lights, camera, combat, player, vehicles, traffic, dmg,
    activeRadius: ACTIVE_RADIUS,
    isDriving: () => state.mode === 'drive',
    prepareTraffic: () => {
      traffic.setBlockers(collectBlockers());
      updateTrafficContext();
      updateTrafficView();
    },
    advanceClock: (simDt) => {
      gameTime += simDt;
    },
    cleanup: cleanupVehicles,
  });
  const stepWorld = worldStep.step;

  // ---------- 特技跳台（Phase 16，§38）：src/stunts.js（純邏輯 + 坡道網格 / 碰撞 + 結算面板）----------
  // 坡道：全部 5 處合成 1 個 Mesh（頂點色，無貼圖 / 陰影）；碰撞 = 每處一個 WORLD 組靜態凸包（同 addStaticBox 直接掛世界）
  const stunts = createStunts({ bus, groundAt: heightAt });
  const stuntRamps = createRampMesh({ THREE, scene, groundAt: heightAt });
  const stuntColliders = addRampColliders(RAPIER, pw.world, { groundAt: heightAt, groups: GROUPS.WORLD });
  const stuntHud = createStuntHud({ root: document.body });
  // 互斥：任務 / 競速 / 警車任務 / 副任務 / 暴走 / 搶劫 / 噴漆 / 被捕・死亡重生畫面進行中 → 起飛不觸發（不慢動作、不計成功）；
  //   起飛後才轉 busy（空中被捕 / 死亡）→ stunts.update 立即無聲中止（不結算、不給錢、timeScale 1、鏡頭歸還）；通緝星數不算（照常觸發）
  const stuntBusy = () => otherMissionBusy() || vigilante.active || rampage.active || !!state.respawn;
  const stuntCtx = {
    busy: false,
    earn: (n) => economy.add(n, 'stunt'),
    toast: (text, seconds) => hud.toast(text, seconds),
  };
  // 車況取樣（同一物件重用）：駕駛中且車體為動態剛體才 active；位置取插值後的 v.pos，速度 / 姿態 / 接地取剛體與車輪控制器
  const stuntSample = { active: false, vehicle: null, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, grounded: false };
  const fillStuntSample = () => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    const vb = v ? v.body : null;
    stuntSample.vehicle = v;
    stuntSample.active = !!vb && !vb.kinematic && vb.active;
    if (!stuntSample.active) return stuntSample;
    const lv = vb.body.linvel();
    const q = vb.body.rotation();
    stuntSample.x = v.pos.x;
    stuntSample.y = v.pos.y;
    stuntSample.z = v.pos.z;
    stuntSample.vx = lv.x;
    stuntSample.vy = lv.y;
    stuntSample.vz = lv.z;
    stuntSample.qx = q.x;
    stuntSample.qy = q.y;
    stuntSample.qz = q.z;
    stuntSample.qw = q.w;
    let grounded = false;
    for (let i = 0; i < vb.layout.wheels.length && !grounded; i++) grounded = !!vb.controller.wheelIsInContact(i);
    stuntSample.grounded = grounded;
    return stuntSample;
  };
  // 每幀（updateRampage 之後）：realDt = 未縮放的幀時間（慢動作時長 / 鏡頭 / 面板計時與 timeScale 無關）
  const updateStunts = (realDt) => {
    stuntCtx.busy = stuntBusy();
    stuntHud.set(stunts.update(realDt, fillStuntSample(), stuntCtx));
  };
  // 電影鏡頭：rig.update 之後以 stunts.cam.weight 從跟車鏡頭內插到側邊追蹤機位（位置 lerp、朝向 slerp）；weight 0 時不動鏡頭
  const stuntRigPos = new THREE.Vector3();
  const stuntRigQuat = new THREE.Quaternion();
  const stuntCamQuat = new THREE.Quaternion();
  const applyStuntCam = () => {
    const c = stunts.cam;
    if (!(c.weight > 0)) return;
    stuntRigPos.copy(camera.position);
    stuntRigQuat.copy(camera.quaternion);
    camera.position.set(c.px, c.py, c.pz);
    camera.lookAt(c.tx, c.ty, c.tz);
    stuntCamQuat.copy(camera.quaternion);
    camera.position.lerpVectors(stuntRigPos, camera.position, c.weight);
    camera.quaternion.slerpQuaternions(stuntRigQuat, stuntCamQuat, c.weight);
  };
  const stuntMk = [];
  const stuntMarkers = () => {
    stuntMk.length = 0;
    return stunts.markers(stuntMk);
  };
  // 開新局 / 回主選單：無聲中止進行中的跳躍、timeScale 回 1、鏡頭交回、面板收起
  const cancelStunts = () => {
    stunts.cancel();
    stuntHud.set(null);
  };

  // ---------- 消防車任務（P18，Firefighter）：src/missions/firefighter.js（純邏輯 + 起火車世界 + 消防隊停放 + 水柱）+ 任務條 + 小地圖 'fire' ----------
  const firefighter = createFirefighter({ bus, rng: Math.random });
  // 起火車：一般 adopt 車（dmg.attach → explosions 點燃 / 延長引信）；任務結束交還一般車輛回收名單（adopted：遠了才消失）
  const fireWorld = createFireWorld({ vehicles, dmg, explosions, traffic, rng: Math.random, onKeep: (v) => adopted.add(v) });
  let fireCar = null; // 出勤那台消防車（耐久歸零 = 車毀失敗）
  const fireTrucks = createFireTruckDepot({
    vehicles, dmg, spot: FIRE_TRUCK_SPOT,
    isBusy: (v) => v === state.vehicle || v === cj.vehicle || v === fireCar,
  });
  const fireBar = createSideJobBar({ root: document.body, prefix: 'fire' });
  const fireStationBeacons = createBeaconPool({ scene, heightAt, ...FIRE_STATION_BEACON }); // 消防隊門口小光柱（常駐 1 根）
  fireStationBeacons.acquire('fire', FIRE_STATION.x, FIRE_STATION.z, FIRE_STATION);
  const waterCannon = createWaterCannonMesh({ THREE, scene }); // 水柱：1 個 InstancedMesh（無貼圖 / 光源 / 陰影）
  // 永久防火：已解鎖時玩家正駕駛的車起火門檻提高、引信延長（explosions.js FIREPROOF_FIRE_AT / FIREPROOF_FUSE_MULT）
  explosions.setFireproof((v) => firefighter.fireproof && state.mode === 'drive' && v === state.vehicle);
  // 互斥旗標：state.firefighter（getter）；otherMissionBusy / 搶劫守門讀 state.racing → 包裝既有 racing getter 併入（不改 otherMissionBusy 原文）
  Object.defineProperty(state, 'firefighter', { get: () => firefighter.active, enumerable: true, configurable: true });
  const racingGetFire = Object.getOwnPropertyDescriptor(state, 'racing').get;
  Object.defineProperty(state, 'racing', { get: () => racingGetFire() || firefighter.active, enumerable: true, configurable: true });
  // vigHooks.active（委託 / 外送 / 垃圾車 / 打工 extraBusy、噴漆廠入口）/ vigHooks.end（BUSTED / WASTED → 任務失敗）
  const vigActiveFire = vigHooks.active;
  vigHooks.active = () => vigActiveFire() || firefighter.active;
  const vigEndFire = vigHooks.end;
  vigHooks.end = (kind) => {
    vigEndFire(kind);
    firefighter.end(kind);
    fireBar.set(null);
  };
  const fireMk = [];
  const fireMarkers = () => {
    fireMk.length = 0;
    return firefighter.markers(fireMk);
  };
  const fireBusy = () => otherMissionBusy() || vigilante.active || rampage.active || stunts.active || !!state.respawn || !!state.spraying;
  const fireNozzle = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
  const fireCtx = {
    player: { x: 0, z: 0 },
    inTruck: false,
    wrecked: false,
    spraying: false,
    nozzle: fireNozzle,
    world: fireWorld,
    earn: (n) => economy.add(n, 'firefighter'),
    toast: (text, seconds) => hud.toast(text, seconds),
    routeLength: (a, b) => {
      const r = findRoute(graph, a, b);
      return r ? r.lengthM : null;
    },
    save: () => autosave.flush('firefighter'), // 第 12 關防火獎勵入檔
  };
  // 水砲輸入：鍵盤 Mouse0（射擊鍵）或備援 KeyX；觸控 tb-spray（駕駛消防車且出勤中才顯示，虛擬 KeyX）；手把 X（gamepad.js getSprayMode：駕駛消防車時 X 由喇叭改送 KeyX）
  registerTouchButton({ id: 'tb-spray', label: '噴水', code: FIRE_SPRAY_KEY, mode: 'hold', slot: 'top1', showWhen: 'drive', hidden: true }); // 借喇叭位置（顯示時隱藏 tb-horn）
  let fireSprayShown = false;
  const setFireSprayButton = (on) => {
    fireSprayShown = on;
    setTouchButtonVisible('tb-spray', on);
    setTouchButtonVisible('tb-horn', !on);
  };
  const fireStartCtx = { inTruck: false, busy: false, stalled: false, overturned: false, world: fireWorld, toast: fireCtx.toast };
  const toggleFirefighter = () => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    if (!v) return;
    if (firefighter.active) {
      firefighter.end('quit', fireCtx);
      return;
    }
    fireStartCtx.inTruck = isFireTruck(v);
    fireStartCtx.busy = fireBusy();
    fireStartCtx.stalled = dmg.healthOf(v) === 0;
    fireStartCtx.overturned = !!v.fallen || v.isOverturned();
    if (fireStartCtx.inTruck && firefighter.start(fireStartCtx)) fireCar = v;
  };
  const fireInter = { text: '', priority: SIDEJOB_PRIORITY, dist: 0, act: toggleFirefighter };
  // 駕駛消防車：未開始 → 開始提示（其他任務中回 null）；進行中 → 收工提示
  const firefighterInteractable = (v) => {
    if (!v || state.respawn || !isFireTruck(v)) return null;
    fireInter.text = firefighter.active ? FIRE_PROMPT_QUIT : fireBusy() ? null : FIRE_PROMPT_START;
    return fireInter.text ? fireInter : null;
  };
  // 每幀（updatePackages 之後）：手機 / BUSTED・WASTED / 噴漆 → 不推進（計時停、水柱關）；spraying = 駕駛消防車按住射擊鍵（任務外也能噴水）
  const updateFirefighter = (dt, skip, attackDown) => {
    fireStationBeacons.update(dt);
    const p = playerPos();
    const v = state.mode === 'drive' ? state.vehicle : null;
    const inTruck = isFireTruck(v);
    const frozen = skip || !!state.respawn || !!state.spraying;
    fireCtx.spraying = !frozen && inTruck && !!attackDown;
    if (inTruck) nozzleOf(v, fireNozzle);
    waterCannon.update(dt, fireCtx.spraying, fireNozzle);
    const sprayBtn = inTruck && firefighter.active;
    if (sprayBtn !== fireSprayShown) setFireSprayButton(sprayBtn);
    if (frozen) {
      firefighter.hold(dt); // 任務計時凍結 → 起火車引信同步延後（explosions 照 simDt 走）
      return;
    }
    fireTrucks.update(dt, p);
    if (firefighter.active) {
      if (inTruck) fireCar = v;
      fireCtx.player.x = p.x;
      fireCtx.player.z = p.z;
      fireCtx.inTruck = inTruck;
      fireCtx.wrecked = !!fireCar && dmg.healthOf(fireCar) === 0;
    }
    const f = firefighter.update(dt, fireCtx);
    if (!f.active) fireCar = null;
    fireBar.set(f.text, f.urgent);
    if (!f.active && fireSprayShown) setFireSprayButton(false);
  };
  // 開新局 / 回主選單：無聲結束（起火車熄火交還、任務條收起、水柱關）
  const cancelFirefighter = () => {
    firefighter.cancel();
    fireWorld.dispose();
    fireCar = null;
    fireBar.set(null);
    waterCannon.update(0, false, null);
    setFireSprayButton(false);
  };

  // ---------- P19 飛車搶包：src/snatch.js（純邏輯；行人掃描每 0.2 s 一次，不新增網格 / 光源）----------
  // 後果一律走既有 API：通緝 wanted.report（snatch / snatchCombo，路人報案 witnessed false）、幫派 gangs.provokeActor、
  //   逃跑 brain.onThreatened（既有 flee 行為）；金錢與統計由 economy 訂閱 snatch:success / snatch:drop 自行處理
  const snatch = createSnatch({
    bus,
    adapters: {
      flee: (ped) => {
        if (ped && ped.brain && ped.brain.onThreatened) ped.brain.onThreatened({ pos: player.pos });
      },
      reportCrime: (crime, opts) => wanted.report(crime, opts),
      provokeGang: (ped) => gangs.provokeActor(ped && ped.actor, 'snatch'),
    },
  });
  const snatchCtx = { riding: false, type: null, speed: 0, overturned: false, x: 0, z: 0, peds: null, frozen: false };
  const updateSnatch = (dt, frozen) => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    snatchCtx.riding = !!v;
    snatchCtx.type = v ? v.type : null;
    snatchCtx.speed = v ? v.speed : 0;
    snatchCtx.overturned = !!v && v.isOverturned();
    snatchCtx.x = v ? v.pos.x : player.pos.x;
    snatchCtx.z = v ? v.pos.z : player.pos.z;
    snatchCtx.peds = traffic.peds;
    snatchCtx.frozen = !!frozen;
    snatch.update(dt, snatchCtx);
    hud.setSnatchCombo(snatch.combo, snatch.mult);
  };
  // 騎機車且附近有可搶行人時，搶包提示優先於其他 interactable（priority 最高）
  const snatchInteractable = () => (snatch.target ? { text: SNATCH_PROMPT, priority: SNATCH_PRIORITY, dist: 0, act: () => snatch.act() } : null);
  const cancelSnatch = () => {
    snatch.cancel();
    hud.setSnatchCombo(0, 1);
  };

  // ---------- P20 故事任務線第一章「七期夜雨」：src/missions/story.js（純邏輯 + 世界轉接 + 任務條 / 字幕框）+ 起點 S 小光柱 + 小地圖 'story' ----------
  // 聯絡人阿海（虛構，KTV 後巷）：步行到 S 按 E 接任務 → 對白（E 下一句 / Enter 跳過）→ 任務；世界操作全走 storyWorld（測試以替身注入同介面）
  const story = createStory({ bus, rng: Math.random, gangOf: (a) => gangs.gangOf(a) });
  // S2 叛徒車：第二個逃犯車世界實例（沿路網逃竄 / 撞停後下車沿用警車任務 createFugitiveWorld；名單與警車任務分開）
  const storyTraitors = createFugitiveWorld({
    vehicles, dmg, traffic, findRoute: (a, b) => findRoute(graph, a, b), rng: Math.random, attacker: () => player.actor,
    isKept: (v) => v === state.vehicle || v === cj.vehicle,
    onKeep: (v) => adopted.add(v),
  });
  // S3 對手幫派成員：沿用暴走的徵用介面（gangs.enlist / release + 骨架重新上色、掛武器）
  const storyGangs = createRampageWorld({
    traffic, gangs, combat,
    repaint: (p) => {
      repaintCharacter(p.character, p.citizen.look);
      p.look = p.citizen.look;
      traffic._gangWeapon(p, p.citizen.gang ? p.citizen.gang.weapon : null);
    },
  });
  const storyVanState = { exists: false, health: null };
  const storyTraitorState = { x: 0, z: 0, speed: 0, health: null, exists: false };
  let storyTraitorUp = false; // 叛徒下車後是否已起身：下車摔倒（spawnEjectedDriver 設 knockdown）不算 KO，起身後再倒地才算
  const storyWorld = {
    spawnVan: (spot) => {
      // 上次失敗留在原地、沒人開的貨車先收走（避免重接時疊在同一點）
      for (const old of vehicles.vehicles.slice()) {
        if (!old.storyVan || old.driven || old === state.vehicle || Math.hypot(old.pos.x - spot.x, old.pos.z - spot.z) > 8) continue;
        dmg.detach(old);
        adopted.delete(old);
        vehicles.remove(old);
      }
      const v = vehicles.adopt({ type: STORY_VAN_TYPE, color: STORY_VAN_COLOR, x: spot.x, z: spot.z, yaw: spot.yaw });
      if (!v) return null;
      v.storyVan = true;
      dmg.attach(v);
      return v;
    },
    vanState: (v) => {
      storyVanState.exists = !!v && vehicles.vehicles.includes(v);
      const h = storyVanState.exists ? dmg.healthOf(v) : null;
      const m = storyVanState.exists ? dmg.maxHealthOf(v) : null;
      storyVanState.health = h !== null && m > 0 ? h / m : null;
      return storyVanState;
    },
    releaseVan: (v) => {
      if (v && vehicles.vehicles.includes(v)) adopted.add(v); // 交還一般車輛（遠了照搶來車回收）
    },
    spawnPoint: (x, z, rMin, rMax) => storyTraitors.spawnPoint(x, z, rMin, rMax),
    spawn: (pt) => storyTraitors.spawn(pt),
    state: (h) => {
      const v = h ? h.v : null;
      const ok = !!v && vehicles.vehicles.includes(v);
      storyTraitorState.exists = ok;
      storyTraitorState.x = ok ? v.pos.x : NaN;
      storyTraitorState.z = ok ? v.pos.z : NaN;
      storyTraitorState.speed = ok ? v.speed || 0 : 0;
      storyTraitorState.health = ok ? dmg.healthOf(v) : null;
      return storyTraitorState;
    },
    drive: (h, c) => storyTraitors.drive(h, c),
    eject: (h) => {
      const a = storyTraitors.eject(h);
      storyTraitorUp = false;
      // 叛徒下車一律逃跑（既有 brain.onThreatened → flee）
      if (a) for (const p of traffic.peds) if (p.actor === a && p.brain && p.brain.onThreatened) p.brain.onThreatened({ pos: player.pos });
      return a;
    },
    remove: (h) => storyTraitors.remove(h),
    isDown: (a) => {
      if (!a) return false;
      const down = combat.isDown(a) || !(a.hp > 0);
      if (!down) storyTraitorUp = true;
      return down && storyTraitorUp; // 撞停下車摔倒中 → 不算；必須起身後再被 KO（玩家擊倒另走 ped:knockdown / ped:dead byPlayer）
    },
    actorPos: (a) => (a && a.pos ? a.pos : null),
    aliveGang: (id, x, z, r) => storyGangs.alive(id, x, z, r),
    isEnlisted: (a) => storyGangs.enlisted.includes(a), // S3 擊倒只算本任務徵用的成員（地盤原生不算）
    spawnGang: (id, x, z, n) => storyGangs.spawn(id, x, z, n),
    releaseGang: () => storyGangs.release(),
    provokeGang: (id, gain) => gangs.provokeGang(id, 'story', gain),
  };
  const storyHud = createStoryHud({ root: document.body, isTouch: touch });
  const storyBeacons = createBeaconPool({ scene, heightAt, ...STORY_BEACON }); // S 起點小光柱（可接任務時 1 根）
  let storyBeacon = null;
  // 章節獎勵：安全屋門口專屬座車（金色轎車；解鎖後常駐，毀損 / 棄置遠處時玩家不在旁才補回）
  const storyCars = createStoryCarDepot({ vehicles, dmg, isBusy: (v) => v === state.vehicle || v === cj.vehicle });
  // 互斥旗標：state.story（getter）；otherMissionBusy / 搶劫守門讀 state.racing → 包裝既有 racing getter 併入（不改 otherMissionBusy 原文）
  Object.defineProperty(state, 'story', { get: () => story.active, enumerable: true, configurable: true });
  const racingGetStory = Object.getOwnPropertyDescriptor(state, 'racing').get;
  Object.defineProperty(state, 'racing', { get: () => racingGetStory() || story.active, enumerable: true, configurable: true });
  // vigHooks.active（委託 / 外送 / 垃圾車 / 打工 extraBusy、噴漆廠入口）/ vigHooks.end（BUSTED / WASTED → 任務失敗）
  const vigActiveStory = vigHooks.active;
  vigHooks.active = () => vigActiveStory() || story.active;
  const vigEndStory = vigHooks.end;
  vigHooks.end = (kind) => {
    vigEndStory(kind);
    story.end(kind);
    storyHud.set(null);
  };
  const storyMk = [];
  const storyMarkers = () => {
    storyMk.length = 0;
    return story.markers(storyMk);
  };
  const storyBusy = () => otherMissionBusy() || vigilante.active || rampage.active || stunts.active || firefighter.active || !!state.respawn || !!state.spraying;
  const storyCtx = {
    player: { x: 0, z: 0 },
    onFoot: false,
    vehicle: null,
    topSpeed: 0,
    wantedStars: 0,
    busy: false,
    frozen: false,
    world: storyWorld,
    earn: (n) => economy.add(n, 'story'),
    toast: (text, seconds) => hud.toast(text, seconds),
    save: () => autosave.flush('story'), // 章節獎勵入檔
  };
  const storyInter = { text: '', priority: SNATCH_PRIORITY + 1, dist: 0, act: () => story.interact(storyCtx) };
  // 互動提示鏈最後一環：對白中 / 可接任務 → 覆蓋為故事提示；其他情況原樣回傳
  const storyInteractable = (inter, allowed) => {
    if (!allowed || state.respawn) return inter;
    const text = story.prompt(storyCtx, touch);
    if (!text) return inter;
    storyInter.text = text;
    return storyInter;
  };
  // 每幀（updateSnatch 之後）：手機 / BUSTED・WASTED / 噴漆 → frozen（計時停、不推進；HUD 維持）；skipPressed = 對白整段跳過
  const updateStory = (dt, skip, skipPressed) => {
    const v = state.mode === 'drive' ? state.vehicle : null;
    const p = playerPos();
    storyCtx.player.x = p.x;
    storyCtx.player.z = p.z;
    storyCtx.vehicle = v;
    storyCtx.topSpeed = v ? v.spec.maxSpeed : 0;
    storyCtx.onFoot = state.mode === 'walk' && !(state.koTimer > 0) && !combat.isDown(player.actor);
    storyCtx.wantedStars = wanted.stars;
    storyCtx.frozen = skip || !!state.respawn || !!state.spraying;
    storyCtx.busy = !story.active && storyBusy();
    if (skipPressed && !storyCtx.frozen) story.skip();
    if (!storyCtx.frozen) storyTraitors.update(dt);
    else storyTraitors.brakeAll();
    storyHud.set(story.update(dt, storyCtx));
    const showS = story.startVisible;
    if (showS && !storyBeacon) storyBeacon = storyBeacons.acquire('story', STORY_CONTACT.x, STORY_CONTACT.z, STORY_CONTACT);
    else if (!showS && storyBeacon) {
      storyBeacons.release(storyBeacon);
      storyBeacon = null;
    }
    if (storyBeacon) storyBeacons.update(dt);
    storyCars.update(dt, p, story.unlocked);
  };
  // 開新局 / 回主選單：無聲失敗（貨車交還、叛徒車回收、徵用成員釋放）、任務條 / 字幕收起
  const cancelStory = () => {
    story.cancel();
    storyTraitors.dispose();
    storyGangs.release();
    storyHud.set(null);
  };

  // ---------- 畫質 / 設定 ----------
  const markMaterialsDirty = () => {
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of [].concat(o.material)) m.needsUpdate = true;
    });
  };
  // 畫質變更即時生效：人車數（traffic.setBudget，逐步增減）、DPR、陰影開關 / 貼圖邊長、視距、自適應解析度
  const applyQuality = () => {
    tier = qualityTier();
    budget = qualityBudget(tier);
    traffic.setBudget(budget);
    const wantShadow = budget.shadowMap > 0;
    if (wantShadow !== renderer.shadowMap.enabled) {
      renderer.shadowMap.enabled = wantShadow; // 關閉由 applyRendererQuality 處理；重新開啟要自己來
      markMaterialsDirty(); // 陰影開關改變 shader，材質需重新編譯
    }
    applyRendererQuality(renderer, 1, scene, tier);
    adapt = createAdaptiveResolution(renderer, tier);
    adaptive = tier === 'low';
    postfx.setTier(tier); // 依新 tier 重建 / 釋放 composer，並跟上新的 pixelRatio
    applyViewDist(budget.viewDist);
    weather.setQuality(budget); // 雨絲數依畫質
    heli.setQuality(); // V5：low 檔關探照燈陰影
  };
  const applyUiScale = (k) => {
    const root = document.documentElement.style;
    root.setProperty('--tg-ui-scale', String(k));
    root.setProperty('--ui-scale', String(k));
    hud.setUiScale?.(k);
  };
  let showFps = settings.get('showFps');
  applyUiScale(settings.get('uiScale'));
  hud.setHintsEnabled?.(settings.get('showHints'));
  hud.setFps?.(null);
  settings.subscribe((key, value) => {
    if (key === 'lookSensMouse') input.setSensitivity({ mouse: value });
    else if (key === 'lookSensTouch') input.setSensitivity({ touch: value });
    else if (key === 'lookSensPad') input.setSensitivity({ pad: value });
    else if (key === 'invertY') input.setInvertY(value);
    else if (key === 'quality') {
      setQualitySetting(value);
      applyQuality();
    } else if (key === 'uiScale') applyUiScale(value);
    else if (key === 'showFps') {
      showFps = !!value;
      if (!showFps) hud.setFps?.(null);
    } else if (key === 'showHints') hud.setHintsEnabled?.(!!value);
    else if (key === 'weather') applyWeatherPref(value);
    else if (isCamViewKey(key)) rig.setViews(camViewsFromSettings(settings)); // 設定頁改段位（V 鍵寫回的同值再套一次無副作用）
  });
  bus.on('weather:setting', (e) => applyWeatherPref(e && e.value));

  const onResize = () => {
    // rig 自行管理 camera.fov，這裡只改 aspect
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    // 保留自適應解析度目前的 renderScale（旋轉螢幕時 dpr 可能改變）
    renderer.setPixelRatio(pixelRatioFor(tier, window.devicePixelRatio, adapt.controller.scale));
    renderer.setSize(window.innerWidth, window.innerHeight);
    postfx.resize();
  };
  window.addEventListener('resize', onResize);

  // ---------- HUD 輔助 ----------
  let controlsMode = null;
  const updateControlsHint = (mode) => {
    if (mode === controlsMode) return;
    controlsMode = mode;
    hud.setControlsHint?.(controlsHintItems(help, mode));
  };
  // 每張提示卡本局只送一次（「只出現一次」的跨局記錄由 hud 內部的 localStorage 負責）
  const hintsSent = new Set();
  const showHint = (id) => {
    if (hintsSent.has(id) || !settings.get('showHints')) return;
    hintsSent.add(id);
    const text = hintText(help, id);
    if (text) hud.showHint?.(id, text);
  };
  let lastHp = null;
  const updateHealth = () => {
    const a = player.actor;
    if (a.hp === lastHp) return;
    lastHp = a.hp;
    hud.setHealth?.(a.hp, a.maxHp);
  };
  bus.on('player:money', ({ money, delta, reason }) => hud.setMoney?.(money, delta, reason));
  // 時段事件（missions/events.js）：開放 / 時段結束提示；取餐 / 送達 / 失敗的字幕由 missions 自己顯示，入帳 reason 'event'（外送）/ 'garbage'（垃圾車）由 hud.setMoney 標示
  bus.on('event:available', (e) => {
    if (!state.started || !e || !e.title) return;
    // 垃圾車（kind 'truck'）：字幕由 missions 顯示，這裡只補簡短 toast（目標會移動，看小地圖 event-truck 標記）
    if (e.kind === 'truck') {
      hud.toast(`🚛 ${e.title}：看小地圖紅點追上它`, 4);
      return;
    }
    const def = missions.events ? missions.events.defs().find((d) => d.id === e.id) : null;
    const where = def && def.pickup && def.pickup.name ? `：到${def.pickup.name}取餐` : '';
    hud.toast(`🌙 ${e.title}開放中${where}`, 5);
  });
  bus.on('event:closed', (e) => {
    // 垃圾車收走（未追車逾時 / 委託開始）不提示「夜市外送時段結束」
    if (e && e.id === 'garbage-truck') return;
    // 取餐開始也會發 closed（此時該事件已進行中）：只在真正關閉（時段結束 / 冷卻）時提示；
    // 依 payload id 查該事件自身狀態（不看「任一事件進行中」：追垃圾車時會吞掉外送的關閉提示）
    if (state.started && !missions.eventRunning(e && e.id)) hud.toast('夜市外送時段結束', 3);
  });
  bus.on('toast', ({ text, seconds } = {}) => {
    if (text) hud.toast(text, seconds);
  });

  // 里程：步行 / 駕駛各自累計（單幀位移過大 = 傳送，不計）
  const lastPos = new THREE.Vector3();
  const trackDistance = (dt, driving, p) => {
    const d = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
    lastPos.copy(p);
    if (d < MAX_STEP_DIST) economy.addDistance(driving ? 'drive' : 'walk', d);
    economy.addPlayTime(dt);
  };

  let roadName = '';
  let roadT = ROAD_NAME_SEC;
  const updateRoadName = (dt, driving) => {
    if (!driving) {
      roadName = '';
      roadT = ROAD_NAME_SEC;
      return;
    }
    roadT += dt;
    if (roadT < ROAD_NAME_SEC) return;
    roadT = 0;
    const r = nearestNamedRoad(focus.x, focus.z, 30);
    roadName = r ? r.road.name : '';
  };

  // ---------- Phase 4 每幀輔助 ----------
  // night：dayNight.night（0–1），垃圾車警示燈亮度；vehicle：駕駛中的 Vehicle 或 null（代客泊車以物件參照辨識指定車，§23.4）
  const missionCtx = { x: 0, z: 0, driving: false, vehicle: null, night: 0 };
  // V 鍵 / 觸控「視角」鈕切段（rig.update onViewChange，同幀最多一次）→ 寫回設定、HUD 顯示「鏡頭：近 / 中 / 遠」1.2 s
  const onCamViewChange = (kind, index) => {
    settings.set(camViewSettingKey(kind), index);
    hud.showCamView(index);
  };
  let lastThrottle = 0;
  // 面板開 / 關的切換：開啟 → 停輸入、放開滑鼠鎖定（不觸發暫停選單）、駕駛中踩煞車；關閉 → 恢復輸入
  let panelWas = false;
  const syncPanels = () => {
    const open = state.started && !state.paused && panelOpen();
    if (open === panelWas) return open;
    panelWas = open;
    if (open) {
      if (phone.isOpen()) phone.close(); // 面板（例：委託結算）蓋過手機：手機先關，syncPhone 見到面板開著不還原輸入
      input.enabled = false;
      releaseLock();
      hud.setPrompt(null);
      hud.setInteractPrompt?.(null);
      if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    } else if (state.started && !state.paused) {
      input.enabled = !state.respawn && !state.spraying; // 被捕 / 送醫畫面、噴漆中維持鎖定（finishRespawn / 噴漆結束解鎖）
      loop.resetClock();
    }
    return open;
  };
  // 大地圖 / 圖鑑開啟中的鍵盤：Esc 或同一顆開啟鍵（M / G）關閉（接單卡 / 結算面板的 E / Esc 由 missions UI 自己處理）
  const onPanelKey = (e) => {
    if (!state.started || state.paused || e.repeat) return;
    let closed = false;
    if (bigMap.isOpen() && (e.code === 'Escape' || e.code === 'KeyM')) {
      bigMap.close();
      closed = true;
    } else if (food.isOpen() && (e.code === 'Escape' || e.code === 'KeyG')) {
      food.close();
      closed = true;
    }
    if (!closed) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onPanelKey, true);

  // 音效每幀狀態（重用）：聆聽點 = 鏡頭；rpm01 = |速度| / 最高速、skid01 = 側滑速度 / SKID_REF、nearJunction = 最近號誌路口距離
  const audioState = {
    x: 0, z: 0, yaw: 0, driving: false, speedKmh: 0, rpm01: 0, throttle: 0, skid01: 0, twoWheeler: false,
    walkSpeed: 0, grounded: true, nearJunction: null, paused: false, rain: 0, garbageTruckDist: Infinity, fireDist: Infinity,
  };
  let junctionT = JUNCTION_SCAN_SEC;
  let junctionDist = null;
  const nearestJunction = (dt, x, z) => {
    junctionT += dt;
    if (junctionT < JUNCTION_SCAN_SEC) return junctionDist;
    junctionT = 0;
    let best = Infinity;
    for (const sig of lights.signals) {
      const d = Math.hypot(sig.x - x, sig.z - z);
      if (d < best) best = d;
    }
    junctionDist = Number.isFinite(best) ? best : null;
    return junctionDist;
  };
  const updateAudio = (dt) => {
    const st = audioState;
    const driving = state.started && state.mode === 'drive' && !!state.vehicle;
    const v = driving ? state.vehicle : null;
    st.x = camera.position.x;
    st.z = camera.position.z;
    st.yaw = rig.yaw;
    st.paused = !state.started || state.paused || panelWas;
    st.driving = driving;
    st.speedKmh = v ? v.speedKmh() : 0;
    st.rpm01 = v ? Math.min(1, Math.abs(v.speed) / (v.spec.maxSpeed || 1)) : 0;
    st.throttle = v ? lastThrottle : 0;
    st.twoWheeler = !!(v && v.spec.twoWheeler);
    st.skid01 = 0;
    if (v && v.body && v.body.body) {
      const lv = v.body.body.linvel();
      const lateral = -lv.x * Math.cos(v.yaw) + lv.z * Math.sin(v.yaw); // 右方 = (−cos yaw, sin yaw)
      st.skid01 = Math.min(1, Math.abs(lateral) / SKID_REF);
    }
    st.walkSpeed = state.started && state.mode === 'walk' ? player.speed : 0;
    st.grounded = player.onGround;
    st.nearJunction = state.started ? nearestJunction(dt, focus.x, focus.z) : null;
    st.rain = weather.getState().rain; // 雨聲（Phase 5）：state.rain > 0.01 時 audio 開 LOOPS.rain
    st.fireDist = state.started ? explosions.nearestFire(focus.x, focus.z) : Infinity; // V4 燃燒聲：最近起火車 / 冒煙殘骸距離
    // 垃圾車音樂：玩家到垃圾車距離（missions.truckState().distM；無車 / 未知 = Infinity）；< 220 m 時 audio 開 LOOPS.garbage_truck（music 群組）
    const tk = state.started ? missions.truckState() : null;
    st.garbageTruckDist = tk && Number.isFinite(tk.distM) ? tk.distM : Infinity;
    audio.update(dt, st);
    // 警笛：暫停 / 全螢幕面板 / 開始畫面時 updateWanted 不跑 → 以 dt 0、paused 靜音（世界不推進）
    if (st.paused) policeAdapters.update(0, adapterIdle);
    // 電台：駕駛中且未暫停才播（暫停 / 面板 / 開始畫面淡出）；暫停中也每幀呼叫
    radioCtx.inVehicle = driving;
    radioCtx.paused = st.paused;
    radio.update(dt, radioCtx);
  };

  // ---------- 更新 ----------
  // 順序：輸入快照 → 選單 / 快轉 → 角色意圖 / 車輛控制 → 物理 step → 上下車 / 搶車 → 鏡頭 / HUD
  const updateGame = (dt) => {
    // 手機開 / 關的轉換（Esc / T / 返回鈕在 keydown / click 內關手機，這裡下一幀才還原輸入）；手機開著世界照跑
    let phoneOpen = syncPhone();
    // 全螢幕面板開啟中：世界與輸入暫停（面板自行處理 E / Esc；大地圖 / 圖鑑的 Esc 見 onPanelKey）
    if (syncPanels()) return;
    const snap = input.snapshot();
    if (snap.pressed.pause) {
      // 選單開啟會同步 emit game:pause { paused: true } → 本幀起世界停止更新
      menu.openPause();
      return;
    }
    if (snap.pressed.map) {
      // M：開大地圖（取代暫停選單的地圖頁；選單內地圖頁保留）
      bigMap.open();
      syncPanels();
      return;
    }
    if (input.wasPressed('KeyG')) {
      openGuide();
      syncPanels();
      return;
    }
    // T：開手機（互斥條件見 canOpenPhone；開著時 input 已停用，關閉由 phone.js 的 Esc / T / 返回處理）
    if (input.actions.pressed('phone') && openPhone()) phoneOpen = true;
    if (snap.pressed.timeSkip) {
      const fast = dayNight.toggleFast();
      hud.toast(fast ? '時間快轉中（再按一次恢復）' : '時間恢復正常', 2.5);
    }
    // Phase 16 特技跳台慢動作：之後的世界更新（物理 / AI / 動畫 / 任務計時）一律吃縮放後的 dt；updateStunts 吃 realDt
    const realDt = dt;
    dt *= stunts.timeScale;

    lastThrottle = 0;
    if (state.mode === 'drive') {
      const v = state.vehicle;
      // 手機開著 / 噴漆中：輸入已停用，每幀維持手煞（不放任車子滑行 / 斜坡溜車）
      const braked = phoneOpen || !!state.spraying;
      v.setControls(braked ? driveControls({ x: 0, y: 0 }, true) : driveControls(snap.move, snap.down.jump));
      lastThrottle = braked ? 0 : snap.move.y;
      if (races.locked) {
        // 街頭競速 3–2–1 倒數：玩家車鎖定（全煞 + 手煞，煞停並維持位置；開賽已要求低速）
        v.setControls(RACE_LOCK_CONTROLS);
        lastThrottle = 0;
      }
      if (input.actions.down('horn')) v.honk(); // 按住連續響（honk 自帶冷卻）
      // Q（或觸控 tb-radio 送的虛擬 KeyQ）：駕駛中 = 換台（步行時 Q 仍是換武器，見 handleWeaponInput）
      if (input.actions.pressedIn('radioNext', 'vehicle')) radio.next();
      aim.aiming = false;
    } else {
      // heavy 委託：步行速度 × missions.speedScale()（駕駛為 1）
      player.speedScale = missions.speedScale();
      player.update(dt, input, rig.yaw);
      // 攻擊 / 切換 / 裝填：weapons（空手時內部呼叫 player.punch()）
      if (state.mode === 'walk') handleWeaponInput(snap);
      else aim.aiming = false;
    }

    updateKnockout(dt);
    stepWorld(dt, state.mode === 'drive' ? state.vehicle.pos : player.pos);
    if (state.pendingFall) handleFall();
    updateWanted(dt, phoneOpen);
    if (!phoneOpen) updateSprayShops(dt);
    updateRobberies(dt, phoneOpen);
    updateVigilante(dt, phoneOpen);
    updateRace(dt, phoneOpen);
    updateGangs(dt, phoneOpen);
    updateSideJobs(dt, phoneOpen);
    updateExplosions(dt);
    handleCarKo(); // 爆炸在 updateGangs 之後：同一幀處理，F 下車不會繞過 WASTED
    updateStreetEvents(dt, phoneOpen);
    updateShops(dt);
    updateRampage(dt, phoneOpen);
    updateStunts(realDt);
    updatePackages(dt);
    updateFirefighter(dt, phoneOpen, state.mode === 'drive' && (snap.down.attack || input.down(FIRE_SPRAY_KEY)));
    updateSnatch(dt, phoneOpen || !!state.respawn); // P19：接在 updateFirefighter 之後（暫停 / 面板 / 重生中凍結）
    updateStory(dt, phoneOpen, input.wasPressed(STORY_SKIP_KEY)); // P20：故事任務（Enter = 對白整段跳過）
    weapons.update(dt, aim);
    updateWeaponPose(aim.aiming);

    let vehiclePrompt = null;
    let inter = null;
    if (state.mode === 'walk') {
      // F 優先序：翻覆車旁 = 扶起 > 可搶車流車 = 搶車 > 路邊車 = 上車
      const free = !player.controlLocked;
      const over = free ? vehicles.findOverturned(player.pos, ENTER_DIST) : null;
      const jack = free && !over ? cj.canStart(player.pos, traffic.carjackCandidates(player.pos.x, player.pos.z, CARJACK_SCAN)) : null;
      const near = free && !over && !jack ? vehicles.findNearby(player.pos, ENTER_DIST) : null;
      if (over) vehiclePrompt = `按 F 扶起${over.spec.label}`;
      else if (jack) vehiclePrompt = `按 F 搶車（${(VEHICLE_TYPES[jack.type] || {}).label || '車'}）`;
      else if (near) vehiclePrompt = `按 F 上車（${near.spec.label}）`;
      if (jack || near) showHint('enter');
      pickups.update(dt, player.pos); // 拾取物（目前無放置點，保留串接）
      inter = free ? nearestInteractable(player.pos, true) : null;
      inter = storyInteractable(inter, free); // P20：對白中「下一句」/ 站在 S 上「接受故事任務」優先
      setPrompts(vehiclePrompt, inter);
      if (snap.pressed.enterExit) {
        if (over) {
          over.upright();
          hud.toast(`已扶起${over.spec.label}`, 2);
        } else if (jack) beginCarjack(jack);
        else if (near) beginEnter(near);
      } else if (snap.pressed.interact && inter && typeof inter.act === 'function') inter.act();
      state.walkTime += dt;
      if (state.walkTime >= HINT_ATTACK_SEC) showHint('attack');
    } else if (state.mode === 'entering') {
      setPrompts(null, null);
      if (player.anim.state === 'drive') enterVehicle(state.vehicle);
      else if (player.anim.state !== 'enter_car') cancelEnter();
    } else if (state.mode === 'carjack') {
      setPrompts(null, null);
      updateCarjack(dt);
    } else {
      const v = state.vehicle;
      player.sitOn(v, dt);
      // 翻覆（汽車翻覆 / 機車倒地持續 1.5 s）→ F 扶起；耐久歸零熄火 → F 下車
      const flipped = v.isOverturned();
      if (flipped) vehiclePrompt = '翻車了！按 F 扶起';
      else if (dmg.healthOf(v) === 0) vehiclePrompt = '車子熄火了，按 F 下車';
      // 駕駛中也可接委託 / 打卡（E）；小吃與彈藥只在步行
      inter = snatchInteractable(); // P19：騎機車且附近有可搶行人 → 「按 E 搶包」最優先
      if (!inter) inter = raceInteractable(v); // 街頭競速起點優先（比賽中 / 其他任務中回 null）
      if (!inter) inter = vigilanteInteractable(v) || nearestInteractable(v.pos, false);
      // 駕駛計程車 / 救護車：開始 / 收工降為後備（只在附近沒有委託 / 打卡等既有互動時出現；其他車回 null）
      if (!inter) inter = sideJobInteractable(v);
      if (!inter) inter = firefighterInteractable(v); // P18：駕駛消防車開始 / 收工（同副任務後備）
      inter = storyInteractable(inter, true); // P20：駕駛中只有對白「下一句」（接任務限步行）
      setPrompts(vehiclePrompt, inter);
      if (snap.pressed.enterExit) {
        if (flipped) v.upright();
        else exitVehicle();
      } else if (snap.pressed.interact && inter && typeof inter.act === 'function') inter.act();
    }

    const driving = state.mode === 'drive';
    const v = driving ? state.vehicle : null;
    focus.copy(driving ? v.pos : player.pos);
    trackDistance(dt, driving, focus);
    autosave.tick(dt);
    state.playTime += dt;
    if (state.playTime >= HINT_PAUSE_SEC) showHint('pause');
    dayNight.update(dt, focus);
    updateEnvironment(dt, worldStep.simDt);
    missionCtx.x = focus.x;
    missionCtx.z = focus.z;
    missionCtx.driving = driving;
    missionCtx.vehicle = v;
    missionCtx.night = dayNight.night;
    // 委託 / 外送 / 垃圾車屬模擬時間（§20）：吃本幀實際推進的 simDt（stepWorld 之後才讀得到；暫停 / 面板開啟時 updateGame 不跑）
    missions.update(worldStep.simDt, missionCtx);
    syncGarbageTruck(worldStep.simDt);
    syncTakeoutBags();
    nav.update(dt, focus);
    // 手機：開著才每幀注入時刻 / 天氣 / 金錢 / missions.listings（同一陣列重用）；update 吃渲染 dt（§20）
    phoneLink.frame(dt);
    food.update(dt, player.pos, camera);
    blood.update(dt, camera);
    // 後座：weapons 本幀累積的鏡頭 pitch / yaw 增量 → rig（衰減回原位）；瞄準中滾輪不縮放鏡頭距離
    const kick = weapons.recoilKick();
    if (kick.pitch || kick.yaw) rig.addRecoil(kick.pitch, kick.yaw);
    const aiming = !driving && aim.aiming;
    if (aiming) input.wheel = 0;
    rig.update(dt, input, focus, {
      driving,
      vehicleYaw: driving ? v.yaw : 0,
      speed: driving ? v.speed : 0,
      distScale: driving ? v.spec.camScale : 1,
      twoWheeler: driving && !!v.spec.twoWheeler,
      cycleView: snap.pressed.camera,
      lookBack: driving && snap.down.lookBack,
      clearRadius: driving ? Math.hypot(v.spec.length, v.spec.width) / 2 : 0,
      clearHeight: driving ? v.spec.height + 0.3 : 0,
      aim: aiming,
      onViewChange: onCamViewChange,
    });
    tour.handoff(dt); // 剛進入遊戲：由巡覽最後鏡位平順內插到玩家鏡頭（§25），結束後不動鏡頭
    applyStuntCam(); // Phase 16：特技跳台電影鏡頭（weight 0 時不動）

    const loc = describeLocation(focus.x, focus.z);
    const placeId = loc.building ? loc.building.id : null;
    if (placeId !== state.placeId) {
      state.placeId = placeId;
      if (loc.building) hud.toast(`📍 ${loc.building.name}`, 4);
    }
    updateRoadName(dt, driving);
    updateControlsHint(driving ? 'drive' : 'walk');
    updateHealth();
    hud.update(dt, {
      x: focus.x,
      z: focus.z,
      yaw: driving ? v.yaw : player.yaw,
      driving,
      speedKmh: driving ? v.speedKmh() : 0,
      vehicleLabel: driving ? v.spec.label : '',
      roadName,
      money: economy.money,
      hp: player.actor.hp,
      hpMax: player.actor.maxHp,
      location: loc.text,
      time: dayNight.timeString(),
      fast: dayNight.fast,
      markers: collectMarkers(hudMarkers, true),
      route: nav.route(),
      searchCircle: wanted.searchCircle,
      policeCars: collectPoliceDots(),
      gangZones: GANG_ZONES,
      weatherIcon: weather.getState().icon,
      radio: radio.getState(),
    });
    whudState.driving = driving;
    whudState.aimBlend = rig.aimBlend;
    whud.update(dt, whudState);
  };

  // 開始畫面 / 回到主選單：電影式運鏡循環巡覽全區（ui/menu-tour.js，契約 §25；世界照常更新，center = 巡覽看點）
  //   鏡位取 OSM 具名建築 / 秋紅谷 basin / 原攤車格；系統「減少動態效果」→ 老虎城慢速環繞；巡覽計時吃渲染 dt（§20 相機）
  const reduceMotionMq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const tourStall = stallSlots.find((s) => s.key === STALL_BASE_KEY) || stallSlots[0];
  const attractFocus = new THREE.Vector3();
  // 進出遊戲距離過遠（> HANDOFF_FADE_DIST 300 m）時的淡出淡入：最小全螢幕黑幕（蓋 3D 畫面、在 HUD z 10 與選單 z 70 之下、不吃滑鼠）
  const tourFade = document.createElement('div');
  tourFade.id = 'tour-fade';
  tourFade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:8;';
  document.body.appendChild(tourFade);
  const tour = createMenuTour({
    camera,
    terrain,
    buildings: cityBuildings,
    namedBuildings,
    roads: surfaceRoads,
    basins: osm.T ? osm.T.basins : [],
    parks: parks.map((p) => p.poly),
    stall: tourStall ? { x: tourStall.pl.x, z: tourStall.pl.z } : { ...NIGHT_MARKET_DELIVERY.pickup, source: 'NIGHT_MARKET_DELIVERY.pickup' },
    reducedMotion: () => !!(reduceMotionMq && reduceMotionMq.matches),
    focus: attractFocus,
    fade: (a) => {
      tourFade.style.opacity = String(a);
    },
  });
  const updateAttract = (dt) => {
    tour.update(dt);
    dayNight.update(dt, attractFocus);
    stepWorld(dt, attractFocus);
    updateEnvironment(dt, worldStep.simDt);
  };

  // ---------- 效能統計（FPS、__game.perf）----------
  // 各項各自一個環形緩衝（stepFrames 只在最後一幀渲染，render 的樣本數可能較少）
  const ring = () => ({ buf: new Float64Array(PERF_FRAMES), i: 0, n: 0 });
  const perfBuf = { render: ring(), physics: ring(), update: ring() };
  const pushSample = (r, v) => {
    r.buf[r.i] = v;
    r.i = (r.i + 1) % PERF_FRAMES;
    r.n = Math.min(PERF_FRAMES, r.n + 1);
  };
  const recordPerf = (renderMs, physicsMs, updateMs) => {
    if (renderMs !== null) pushSample(perfBuf.render, renderMs);
    pushSample(perfBuf.physics, physicsMs);
    pushSample(perfBuf.update, updateMs);
  };
  const fpsState = { acc: 0, frames: 0, fps: 0 };
  const updateFps = (dt) => {
    fpsState.acc += dt;
    fpsState.frames++;
    if (fpsState.acc < FPS_SAMPLE_SEC) return;
    fpsState.fps = fpsState.frames / fpsState.acc;
    fpsState.acc = 0;
    fpsState.frames = 0;
    if (showFps) hud.setFps?.(Math.round(fpsState.fps));
  };
  let drawCalls = 0;
  // 大地圖 / 圖鑑蓋滿畫面時不渲染 3D（契約 §19；畫布保留最後一幀）
  const render = () => {
    if (hide3D()) return;
    postfx.render();
    drawCalls = postfx.info.sceneCalls; // 場景本身的 draw call（不計 post pass）
  };

  // 每幀排程（core/loop.js）：世界更新 → 音效 → 渲染 → 效能統計 → 輸入收尾
  const loop = createFrameLoop({
    world: worldStep,
    isPaused: () => state.paused,
    isStarted: () => state.started,
    updateGame,
    updateAttract,
    updateAudio,
    render,
    recordPerf,
    updateFps,
    endFrame: () => input.endFrame(),
    adaptTick: (dt) => {
      if (adaptive) adapt.tick(dt);
    },
  });

  // ---------- 選單流程 ----------
  const mapView = createMapView({ getPlayer: () => ({ x: focus.x, z: focus.z, yaw: state.mode === 'drive' && state.vehicle ? state.vehicle.yaw : player.yaw }) });
  const menu = createMenu({
    root: document.body,
    settings,
    bus,
    keymapHelp: KEYMAP_HELP,
    touchHelp: TOUCH_HELP,
    gamepadHelp: GAMEPAD_HELP,
    isTouch: touch,
    attribution: ATTRIBUTION,
    getStats: () => currentStats(),
    getMoney: () => economy.money,
    hasSave: () => store.hasSave(),
    mapView,
    onOpenGuide: () => openGuide(), // I4b：暫停選單「圖鑑」按鈕
  });

  // 桌機滑鼠鎖定：只能在使用者手勢（開始 / 繼續的 click / keydown）內要求
  const lockTarget = renderer.domElement;
  let hadLock = false;
  const requestLock = () => {
    if (touch || panelOpen() || document.pointerLockElement === lockTarget || !lockTarget.requestPointerLock) return;
    try {
      const p = lockTarget.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      // 忽略：冷卻中 / 不支援時之後點畫面仍可鎖定
    }
  };
  const releaseLock = () => {
    hadLock = false;
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  };
  // 遊戲中滑鼠鎖定被解除（Esc 被瀏覽器吃掉、切視窗）→ 開暫停選單
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === lockTarget) {
      hadLock = true;
      return;
    }
    const lost = hadLock;
    hadLock = false;
    if (lost && state.started && !state.paused && !menu.isOpen() && !panelOpen()) menu.openPause();
  });

  // mobile.js 的「開始遊戲」手勢（全螢幕 → 螢幕不變暗、body.playing）掛在 #start-btn 的 click 上：
  // 開始畫面按鈕的 click 內同步轉發一次（程式觸發的 click 仍在同一使用者手勢內）
  const mobileStart = () => {
    const btn = document.getElementById('start-btn');
    if (btn) btn.click();
  };

  // 存檔位置的建築判定：主角膠囊（略縮）放在該點地面上，與建築碰撞體（colliderStats.handles.building）重疊才算在建築內；
  // 物理查詢失敗時退回「點在輪廓內」
  const buildingHandles = new Set((colliderStats.handles && colliderStats.handles.building || []).map((c) => c.handle));
  const saveProbe = new RAPIER.Capsule(player.capsuleHalfHeight, PLAYER_RADIUS * SAVE_POS_SHRINK);
  const saveProbeRot = { x: 0, y: 0, z: 0, w: 1 };
  const solidAt = (x, z) => {
    try {
      const y = terrain.querySurface(x, z, Infinity).y + player.capsuleHalfHeight + PLAYER_RADIUS + 0.05;
      let hit = false;
      pw.intersections({ x, y, z }, saveProbeRot, saveProbe, () => {
        hit = true;
        return false;
      }, { predicate: (c) => buildingHandles.has(c.handle) });
      return hit;
    } catch (err) {
      console.warn('[save] 存檔位置物理查詢失敗，改用建築輪廓判定', err);
      return !!buildingAt(x, z, 0);
    }
  };

  // 開新局 / 繼續：重設玩家（離開車輛、hp 回滿）並放到存檔位置（無效、在建築碰撞體內或水中 → 出生點）
  // Phase 14：存檔有最後使用的安全屋（safehouse.last，舊存檔 / 新局沒有）→ 改從該安全屋門口出生（同樣經 validSavedPosition 檢查）
  const placePlayer = (save) => {
    if (cj.active) cj.cancel();
    if (state.mode === 'drive') exitVehicle(true);
    state.mode = 'walk';
    state.vehicle = null;
    state.koTimer = 0;
    state.pendingFall = null;
    player.locked = false;
    player.actor.untargetable = false;
    player.mesh.visible = true;
    const home = safehouses.spawnPoint(save.safehouse || null);
    const p = home ? { x: home.x, z: home.z, yaw: home.yaw } : save.player;
    const ok = validSavedPosition(p, { solidAt, buildingAt, inWater, inBounds });
    const x = ok ? p.x : spawn.x;
    const z = ok ? p.z : spawn.z;
    const yaw = ok && Number.isFinite(p.yaw) ? p.yaw : spawn.yaw;
    player.placeAt(x, z, yaw, terrain);
    if (combat.isDown(player.actor)) combat.revive(player.actor);
    player.actor.hp = player.actor.maxHp;
    rig.yaw = yaw;
    lastPos.copy(player.pos);
    focus.copy(player.pos);
  };

  // 存檔狀態提示（備份還原 / 損毀重設 / 版本較新）：開始畫面一出現就顯示在標題下（沿用選單副標題樣式，暫停時選單 CSS 會隱藏），開始遊戲後移除
  let startNoticeEl = null;
  const showStartNotice = (text) => {
    const brand = menu.el && menu.el.querySelector ? menu.el.querySelector('.tg-menu-brand') : null;
    if (!text || !brand) return;
    if (!startNoticeEl) {
      startNoticeEl = document.createElement('div');
      startNoticeEl.className = 'tg-menu-sub tg-save-notice';
      startNoticeEl.setAttribute('role', 'status');
      brand.appendChild(startNoticeEl);
    }
    startNoticeEl.textContent = `⚠ ${text}`;
  };
  const clearStartNotice = () => {
    if (startNoticeEl) startNoticeEl.remove();
    startNoticeEl = null;
  };

  // 關掉所有全螢幕面板（新局 / 回主選單）
  const closePanels = () => {
    if (bigMap.isOpen()) bigMap.close();
    if (food.isOpen()) food.close();
    if (missions.isModalOpen()) missions.ui.closePanel();
    if (gunShop.isOpen()) gunShop.close();
    panelWas = false;
    phoneLink.reset();
  };

  const startGame = (continued) => {
    clearStartNotice();
    const { data } = store.load();
    // 版本較新的存檔（incompatible）只有玩家選「開始新遊戲」才清掉
    if (!continued && store.blocked) store.clear();
    const save = continued ? data : defaultSave();
    economy.dispose();
    economy = createEconomy({ bus, initial: save });
    resetExtraStats(save.stats);
    closePanels();
    cancelVigilante();
    cancelRace();
    cancelSideJobs();
    gangs.cancel();
    cancelSnatch(); // P19：連擊 / 已被搶名單歸零
    cancelFirefighter(); // P18：先於 clearExplosions（fireWorld.remove 要看得到起火狀態才熄火修復；之後 clear 不會留下低耐久起火車）
    clearExplosions();
    cancelStreetEvents();
    cancelRobbery(!continued);
    cancelSpray();
    cancelShops();
    cancelRampage();
    cancelStunts();
    cancelStory(); // P20：任務中 → 無聲失敗（貨車 / 叛徒車 / 徵用成員回收）、字幕收起
    cancelPackages();
    cancelRespawn();
    policeV5.cancel(); // V5：直升機 / 路障 / 特警立即回收
    safehouses.restore(save.safehouse); // Phase 14：最後使用的安全屋（新局 defaultSave 無此欄 → null）；placePlayer 據此決定出生點
    placePlayer(save);
    ambulances.ensure(true); // 醫院旁救護車（停放點附近且完好就沿用；棄置遠處的收回重生）
    fireTrucks.ensure(true); // P18：消防隊前庭的消防車（同救護車規則）
    // 存檔 v2 各模組還原（新局 = defaultSave 的預設值）；進行中的委託由 missions.restore 作廢
    weapons.restore(save.weapons);
    missions.restore(save.missions);
    races.restore(save.races); // 舊存檔無 races → 清空最佳成績
    rampage.restore(save.rampage); // Phase 15：舊存檔無 rampage → 全部未完成
    stunts.restore(save.stunts); // Phase 16：舊存檔無 stunts → 全部未完成
    packages.restore(save.packages); // Phase 17：舊存檔無 packages → 0 收集
    firefighter.restore(save.firefighter); // P18：舊存檔無 firefighter → 未解鎖防火
    snatch.restore(save.stats); // P19：搶包統計存在 save.stats（缺欄位視 0）
    story.restore(save.story); // P20：舊存檔無 story → 從第一關開始
    storyCars.ensure(true, null, story.unlocked); // P20：章節獎勵座車（未解鎖 → 收回）
    syncGarbageTruck(0); // 讀檔作廢進行中的垃圾車 → 車體隱藏
    checkins.restore(save.collect);
    food.restore(save.collect);
    nav.clear('map');
    blood.clear();
    dayNight.hour = save.world.hour;
    tour.stop(); // 巡覽停止，handoff 接回玩家鏡頭
    state.started = true;
    state.paused = false;
    state.walkTime = 0;
    state.playTime = 0;
    state.placeId = null;
    controlsMode = null;
    lastHp = null;
    input.enabled = true;
    hud.setVisible(true);
    whud.setVisible(true);
    whud.setDriving(false);
    hud.setMoney?.(economy.money, 0);
    mobileStart();
    setGameActive(true);
    requestLock();
    loop.resetClock();
    if (!continued) autosave.flush('newGame'); // 讓「繼續」立刻反映新局
    // 存檔狀態提示（備份還原 / 損毀重設 / 版本較新）優先於歡迎詞，只提示一次
    if (saveNotice) hud.toast(saveNotice, 5);
    else hud.toast(continued ? '歡迎回來！' : '歡迎來到臺中七期！你站在老虎城外、河南路三段這一側，附近路邊有車可以開。', 6);
    saveNotice = null;
    showHint('move');
  };

  const pauseGame = () => {
    if (!state.started || state.paused) return;
    state.paused = true;
    phoneLink.reset(); // 暫停（含手機設定 App、切背景失去滑鼠鎖定）一律收起手機；繼續時不自動再開
    input.enabled = false;
    if (state.mode === 'drive' && state.vehicle) state.vehicle.setControls(driveControls({ x: 0, y: 0 }, true));
    autosave.flush('pause');
    setGameActive(false);
    releaseLock();
  };

  // 「繼續」的 click / keydown 內同步呼叫（menu 在同一手勢內 emit game:pause { paused: false }）
  const resumeGame = () => {
    if (!state.started || !state.paused) return;
    state.paused = false;
    // 被捕 / 送醫畫面進行中維持鎖輸入（由 finishRespawn 解鎖）；滑鼠鎖定照樣在本手勢內同步要求（畫面的點擊跳過走 document 捕獲監聽，鎖定中仍收得到）
    if (!state.respawn && !state.spraying) input.enabled = true; // 噴漆中亦維持鎖定（噴漆結束時解鎖）
    setGameActive(true);
    requestLock();
    loop.resetClock();
  };

  const quitToMenu = () => {
    if (state.started) autosave.flush('quitToMenu');
    if (cj.active) cj.cancel();
    if (state.mode === 'drive') exitVehicle(true);
    state.mode = 'walk';
    player.locked = false;
    cancelVigilante();
    cancelRace();
    cancelSideJobs();
    gangs.cancel();
    cancelSnatch(); // P19：連擊 / 已被搶名單歸零
    cancelFirefighter(); // P18：先於 clearExplosions（fireWorld.remove 要看得到起火狀態才熄火修復；之後 clear 不會留下低耐久起火車）
    clearExplosions();
    cancelStreetEvents();
    cancelRobbery();
    cancelSpray();
    cancelShops();
    cancelRampage();
    cancelStunts();
    cancelStory(); // P20：任務中 → 無聲失敗（貨車 / 叛徒車 / 徵用成員回收）、字幕收起
    cancelPackages();
    cancelRespawn();
    policeV5.cancel(); // V5：直升機 / 路障 / 特警立即回收
    state.started = false;
    state.paused = false;
    input.enabled = false;
    tour.start(); // 恢復選單巡覽（時間接續，由當下鏡頭內插回路徑）
    closePanels();
    hud.setVisible(false);
    whud.setVisible(false);
    hud.setPrompt(null);
    hud.setInteractPrompt?.(null);
    setGameActive(false);
    releaseLock();
  };

  bus.on('game:start', ({ continued } = {}) => startGame(!!continued));
  bus.on('game:pause', ({ paused } = {}) => (paused ? pauseGame() : resumeGame()));
  bus.on('game:quitToMenu', () => quitToMenu());

  // 切背景：物理暫停（累加器歸零、插值對齊）並立即存檔；回前景時從目前時間重新計時
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      pw.pause();
      if (state.started) autosave.flush('hidden');
    } else {
      pw.resume();
      loop.resetClock();
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.started) autosave.flush('pagehide');
  });

  loop.frame();
  // 載入完成：loading 只負責進度，之後交給選單的開始畫面
  loading.ready();
  input.enabled = false;
  hud.setVisible(false);
  whud.setVisible(false);
  menu.showStart({ canContinue: store.hasSave() });
  showStartNotice(saveNotice);

  // 除錯用（僅 dev，正式 build 由 Vite 以 import.meta.env.DEV = false 整段移除）：主控台 / 外部腳本用 window.__game 檢視狀態、直接設輸入；
  // rAF 不跑時（背景分頁）可 stepFrames(n, dt) 手動推幀（含渲染一次）再截圖
  if (import.meta.env.DEV) {
    // 背景分頁時物理是暫停的：手動推幀也要推進物理，所以暫時解除暫停、推完再恢復原狀
    const withPhysics = (fn) => {
      const paused = pw.paused;
      if (paused) pw.resume();
      try {
        fn();
      } finally {
        if (paused) pw.pause();
      }
    };
    const devUpdateGame = (dt) => withPhysics(() => updateGame(dt));
    const perf = () => ({
      frames: perfBuf.update.n,
      fps: fpsState.fps,
      render: perfStats(perfBuf.render.buf, perfBuf.render.n),
      physics: perfStats(perfBuf.physics.buf, perfBuf.physics.n),
      update: perfStats(perfBuf.update.buf, perfBuf.update.n), // 更新（不含物理步）
      peds: { total: traffic.citizens.length, skeleton: traffic.peds.length, impostor: traffic.impostors ? traffic.impostors.count : 0 },
      cars: traffic.cars.length,
      drawCalls,
      tier,
    });
    window.__game = {
      scene, camera, renderer, player, vehicles, traffic, combat, dayNight, state, input, hud, rig, terrain, qiuhonggu,
      beginEnter, enterVehicle, exitVehicle, world, buildings, spawn, parked, updateGame: devUpdateGame, updateAttract, menuTour: tour, render,
      physics: { RAPIER, world: pw, router, colliders: colliderStats, character, occluder },
      bus, settings, saveStore: store, autosave, menu, mapView, lights, damage: dmg, carjack: cj,
      // Phase 4：武器 / 音效 / 流血 / 委託 / 導航 / 大地圖 / 打卡 / 小吃（audio.stats()、blood.stats() 看音源數與血跡數）
      weapons, audio, blood, missions, nav, bigMap, checkins, food, pickups, whud, truckMesh, stall, stalls, valetSites, valetCars, phone, phoneLink, gangs, gangCars,
      // Phase 5：天氣 / 環境 / 電台（weather.setWeather('rain', { instant: true })、radio.getState()）
      weather, env, radio,
      // Phase 7：通緝 / 警力（wanted.setStars(3)、police.cars / officers、policeAdapters.stats()）
      wanted, police, policeAdapters, wantedUI,
      // V5：警方升級（heli.stats()、police.roadblocks / swat）
      heli,
      // Phase 8：噴漆廠（sprayShops.shops 看每間店的 cooldown / hold）
      sprayShops,
      // Phase 9：超商搶劫（robberies.stores 看每間店 state / cooldown；clerks = 目前生成的店員）
      robberies, clerks,
      // Phase 11：警車任務（vigilante.fugitives 看逃犯車狀態；fugitiveWorld.cars = 受控逃犯車）
      vigilante, fugitiveWorld, vigBar,
      // Phase 12：街頭競速（races.start('qiqi-classic') 除錯開賽；races.rivals 看對手車進度；rivalWorld.cars = 受控對手車）
      races, rivalWorld, raceHud,
      // Phase 13：計程車 / 救護車副任務（taxi.start() / ems.start() 除錯開始；curbPeds.live = 招手乘客 / 傷患；ambulances.vehicle = 救護車）
      taxi, ems, curbPeds, ambulances,
      // V3：街頭事件（streetEvents.events 看各 slot；streetWorld.stats() 看事件車 / 待回收行人）
      streetEvents, streetWorld,
      // 補手槍備彈（回實際加入數，上限 120）
      giveAmmo(n = 36, id = 'pistol') {
        return weapons.addAmmo(n, id);
      },
      // Phase 14：武器店 / 安全屋（gunShop.open('gunshop-ntc')、safehouses.enter('safehouse-henan')）；直接給長槍（除錯）
      gunShop,
      safehouses,
      giveWeapon(id = 'smg') {
        return weapons.give(id);
      },
      // Phase 15：暴走（rampage.start('rampage-suits') 除錯開始；rampage.current / kills / remain 看進度；rampageWorld.alive / spawn 看補敵人）
      rampage, rampageWorld, rampageHud,
      // Phase 16：特技跳台（stunts.phase / timeScale / cam 看狀態；stunts.list[i].x / z / yawDeg 是坡腳與起飛方向）
      stunts, stuntHud, stuntRamps, stuntColliders,
      // Phase 17：隱藏包裹（packages.collect('pkg-01') 除錯收集；packages.list[i].x / y / z 是點位；packages.resupply() 立即補給）
      packages, packageMesh,
      // P18：消防車任務（firefighter.start() 除錯開始；firefighter.slots 看起火車火勢；fireTrucks.vehicle = 消防隊停放的消防車）
      firefighter, fireWorld, fireTrucks, waterCannon, fireStationBeacons,
      // P19：飛車搶包（snatch.target 看目前鎖定行人；snatch.combo / mult 看連擊）
      snatch,
      // P20：故事任務（story.accept(ctx) / next() / skip()；story.phase / stage / kills；storyWorld 世界轉接；storyCars.vehicle = 安全屋專屬座車）
      story, storyWorld, storyHud, storyCars, storyBeacons,
      // 最近的骨架行人 → { id, dist, hp, state }（沒有回 null）
      nearestPed() {
        let best = null;
        let bestD = Infinity;
        for (const p of traffic.peds) {
          const a = p.actor;
          if (!a) continue;
          const d = Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z);
          if (d < bestD) {
            bestD = d;
            best = a;
          }
        }
        return best ? { id: best.id, dist: bestD, hp: best.hp, state: combat.stateOf(best) } : null;
      },
      // 傳送玩家到 (x, z)（駕駛中先下車；不計里程）
      teleport(x, z) {
        if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
        if (state.mode === 'drive') exitVehicle(true);
        player.placeAt(x, z, player.yaw, terrain);
        lastPos.copy(player.pos);
        focus.copy(player.pos);
        return true;
      },
      // 直接接單（測試用）：slug 必須是目前開放的委託；有 UI 時自動按「接下」；回傳是否已進行中
      startMission(slug) {
        const m = missions.catalog().find((c) => c.slug === slug);
        if (!m || missions.active() || missions.offers().indexOf(slug) < 0) return false;
        const it = missions.nearest(m.from);
        if (!it || it.id !== `mission:${slug}`) return false;
        it.act();
        const els = missions.ui.els;
        const btn = els && els.panel && els.panel.querySelector ? els.panel.querySelector('.ms-btn-primary') : null;
        if (btn && missions.ui.mode() === 'offer') btn.click();
        return !!missions.active();
      },
      get adapt() {
        return adapt;
      },
      get economy() {
        return economy;
      },
      get quality() {
        return { tier, budget: { ...budget }, setting: settings.get('quality') };
      },
      // 畫質即時切換（'auto' | 'low' | 'mid' | 'high' | 'ultra'）；回傳生效的 tier
      setQuality(id) {
        settings.set('quality', id);
        return tier;
      },
      // 手動推 n 幀（每幀 dt 秒，暫停中世界不動），推完渲染一次；回傳 perf()
      stepFrames(n = 1, dt = 1 / 60) {
        withPhysics(() => loop.runFrames(n, dt));
        return perf();
      },
      perf,
    };
  }
}

init().catch((err) => {
  console.error(err);
  loading.error(`載入失敗：${err && err.message ? err.message : err}（請確認瀏覽器支援 WebGL）`);
});
