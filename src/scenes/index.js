/**
 * src/scenes — Phaser scenes. Registry + lifecycle contract:
 *
 *   BootScene   loads 'boot' asset pack, inits core singletons
 *               (InputManager.init, AudioManager.init, SaveManager.open),
 *               then -> TitleScreen.
 *   TitleScene  staged 'title' assets; New Game -> reset GameState ->
 *               GameScene('moonlit_gate_001'); Continue -> SaveScreen.
 *   GameScene   persistent gameplay scene: owns Player, RoomManager,
 *               HitboxSystem, ProjectileSystem, HUD. Handles room transitions,
 *               auto-pause on 'game:autoPause', debug overlay hook.
 *   UIScene     overlay scene for menus/dialogue (pause coordination).
 *
 * CONTRACT:
 * - Scene keys: 'Boot', 'Title', 'Game', 'UI'. Registered in gameConfig.scene
 *   by Wave 1 (Boot + Title), Wave 2/3 (Game), Wave 5 (UI).
 * - GameScene is NEVER restarted for room changes — RoomManager swaps room
 *   content inside it (spec §26 seamless transitions).
 * - Scenes communicate via eventBus, never direct references.
 */
export const SceneKeys = Object.freeze({
  BOOT: 'Boot',
  TITLE: 'Title',
  GAME: 'Game',
  UI: 'UI',
});

export { BootScene } from './BootScene.js';
export { TitleScene } from './TitleScene.js';
export { GameScene } from './GameScene.js';
export { UIScene } from './UIScene.js';
