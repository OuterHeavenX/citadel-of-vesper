/**
 * src/config — static configuration. Public API surface:
 *
 *   gameConfig.js  Phaser boot config (480x270 pixelArt, Arcade physics)
 *   tuning.js      ALL movement/combat/camera numbers (game-feel lives here)
 *   assets.js      AssetPacks manifests for staged loading
 */
export { gameConfig } from './gameConfig.js';
export { tuning, setTuning } from './tuning.js';
export { AssetPacks } from './assets.js';
