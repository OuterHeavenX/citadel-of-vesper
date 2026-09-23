/**
 * src/core — foundation singletons. Public API surface:
 *
 *   EventBus.js      class EventBus, Events (frozen catalog), eventBus singleton
 *   GameState.js     gameState singleton, createInitialState(), SAVE_SCHEMA_VERSION
 *   SaveManager.js   saveManager singleton — IndexedDB, schema v1, export/import
 *   InputManager.js  inputManager singleton — actions, keyboard/gamepad/touch
 *   AudioManager.js  audioManager singleton — 7 channels, crossfade music
 *   AssetManager.js  assetManager singleton — staged loading, adjacent preload
 *   DataManager.js   dataManager singleton — bundled data/*.json access
 *
 * Rules: core modules never import from player/, enemies/, ui/, scenes/.
 * They may import ./EventBus.js only (+ static JSON data in DataManager).
 * Everything else talks to core via the singletons and the event catalog.
 */
export { EventBus, Events, eventBus } from './EventBus.js';
export { gameState, createInitialState, SAVE_SCHEMA_VERSION } from './GameState.js';
export { saveManager, SaveManager, DB_NAME, SAVE_SLOTS } from './SaveManager.js';
export { inputManager, InputManager, Actions, Devices, DEFAULT_KEYBOARD_BINDINGS, DEFAULT_GAMEPAD_BINDINGS } from './InputManager.js';
export { audioManager, AudioManager, Channels } from './AudioManager.js';
export { assetManager, AssetManager, Stages, LoadingIndicator, LOAD_INDICATOR_MS, LOAD_TIMEOUT_MS, FALLBACK_TEXTURE_KEY } from './AssetManager.js';
export { dataManager, DataManager, DATASET_NAMES } from './DataManager.js';
