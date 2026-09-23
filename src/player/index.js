/**
 * src/player — Lucien Vale. Public API surface:
 *
 *   Player.js           class Player — facade; the only thing scenes touch
 *   PlayerMovement.js   class PlayerMovement — locomotion, reads tuning.js
 *   PlayerCombat.js     class PlayerCombat — data-driven attacks, i-frames
 *   PlayerStats.js      class PlayerStats — derived stats, XP, leveling
 *   PlayerAnimation.js  class PlayerAnimation — animation keys + timings
 *
 * Rules: movement constants live ONLY in src/config/tuning.js.
 * Damage flows ONLY through src/combat/DamageSystem.js.
 *
 * INTEGRATION (W2-COMBAT): PlayerCombat / PlayerAnimation are implemented by
 * the W2-COMBAT agent on this branch. Player never constructs them — GameScene
 * (Wave 3) calls player.attachCombat(new PlayerCombat(player)) and
 * player.attachAnimation(new PlayerAnimation(player.getSprite())).
 * Until attached, player.getCombat() returns null and the combat/animation
 * update paths are skipped.
 */
export { Player } from './Player.js';
export { PlayerMovement } from './PlayerMovement.js';
export { PlayerCombat } from './PlayerCombat.js';
export { PlayerStats } from './PlayerStats.js';
export { PlayerAnimation } from './PlayerAnimation.js';
