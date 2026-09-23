/**
 * src/map — exploration map. Public API surface:
 *
 *   MapModel.js    class MapModel, mapModel singleton — completion %, room
 *                  nodes, unexplored doors, markers (Phaser-free)
 *   MapOverlay.js  class MapOverlay — functional fullscreen map overlay
 *                  (Wave 5 owns the gothic visual restyle)
 *
 * Secret rooms stay hidden until found. Rendering never touches the model
 * except through its read API; discovery mutations go through
 * gameState.discoverRoom().
 */
export { MapModel, mapModel } from './MapModel.js';
export { MapOverlay } from './MapOverlay.js';
