// 角色模組匯出：glb 載入 / 複製 / 換色（model.js）與動畫狀態機（animator.js）
export {
  loadCharacterModels,
  createCharacter,
  disposeCharacter,
  getCharacterManifest,
  DEFAULT_CHARACTER_MANIFEST,
  DEFAULT_VARIANT,
  MODEL_YAW_OFFSET,
} from './model.js';
export { CharacterAnimator, PUNCH_HIT_WINDOW, RATE_MIN, RATE_MAX, STATES, LOCOMOTION, ONE_SHOTS } from './animator.js';
