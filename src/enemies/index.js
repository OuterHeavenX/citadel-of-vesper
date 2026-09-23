/**
 * src/enemies — ORIGINAL enemy designs only. Public API surface:
 *
 *   Enemy.js         class Enemy — AI states: idle|patrol|pursue|attack|stagger|dead
 *                    + rollDrops() pure helper
 *   EnemyFactory.js  class EnemyFactory — registry + create(enemyId, ...)
 *   variants.js      the 8 vertical-slice subclasses (self-registering)
 *   index.js         createEnemyAnims(scene, defs)
 *
 * Vertical slice: 8 enemy types across Moonlit Gate + Hollow Keep.
 * Enemy definitions: data/enemies.json (schema: data/schemas/enemy.schema.json).
 * Bestiary data flows to src/ui via gameState.data.bestiary.
 *
 * Import order matters: variants.js self-registers with EnemyFactory, so it
 * must be imported after EnemyFactory.js (done below).
 */
export { Enemy, rollDrops } from './Enemy.js';
export { EnemyFactory } from './EnemyFactory.js';
export {
  AshHound,
  RustboundRevenant,
  CinderWisp,
  HollowSentinel,
  VellumPhantom,
  VesperChimer,
  MoteSwarm,
  CinderMastiff,
} from './variants.js';

/** Animation suffixes the art pipeline may produce per enemy id. */
const ENEMY_ANIM_SUFFIXES = ['idle', 'run', 'walk', 'attack'];

/** Frames-per-second per animation kind (matches assets/enemies/enemies.json). */
const ENEMY_ANIM_FPS = { idle: 4, run: 8, walk: 6, attack: 10 };

/**
 * Create `<sprite>_<anim>` animations from the loaded 2-frame strips
 * (assets/enemies/<id>_<anim>.png per ART_PIPELINE.md naming). Only creates
 * anims whose texture is actually in the cache — enemies with just an idle
 * sheet still work; Enemy.playAnim() no-ops on missing keys.
 *
 * RoomManager should call this once per region pack load:
 *   createEnemyAnims(scene, dataManager.getData('enemies'))
 *
 * @param {Phaser.Scene} scene
 * @param {Array<object>} defs enemy definitions (need `sprite`)
 */
export function createEnemyAnims(scene, defs) {
  if (!scene || !scene.anims || !scene.textures) return;
  for (const def of defs ?? []) {
    for (const suffix of ENEMY_ANIM_SUFFIXES) {
      const key = `${def.sprite}_${suffix}`;
      if (!scene.textures.exists(key)) continue;
      if (scene.anims.exists(key)) continue;
      try {
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(key, { start: 0, end: 1 }),
          frameRate: ENEMY_ANIM_FPS[suffix] ?? 6,
          repeat: -1,
        });
      } catch {
        /* a missing frame layout must never break room load */
      }
    }
  }
}
