/**
 * MapModel — exploration map data (spec §27).
 *
 * CONTRACT:
 * - Source of truth for discovery: gameState.data.map.discovered (roomIds).
 *   The model NEVER mutates it directly — `discover()` goes through
 *   gameState.discoverRoom(), which emits `map:roomDiscovered`.
 * - getCompletion(): percent of NON-SECRET rooms discovered. Secret rooms
 *   (room.hidden === true) NEVER count until found, and never render until
 *   discovered.
 * - getRoomNode(roomId): { roomId, name, region, x, y, discovered,
 *   isHidden, isSaveRoom, isTeleport, isBoss, hasUnexploredExit } — layout
 *   coordinates come from room def `map: { x, y }` grid cells.
 * - Map UI (MapOverlay) renders from this model; the model never touches
 *   Phaser — it is importable from node (tests, scripts).
 * - Special markers: save rooms, teleport chambers, boss rooms — exposed as
 *   discovered-only marker lists for the overlay.
 *
 * Construct with the room defs: `new MapModel(rooms, { bosses })`.
 * A shared `mapModel` singleton is exported for UI convenience; call
 * `mapModel.init(rooms, opts)` once the room data is loaded (Wave 5 wiring).
 */
import { gameState } from '../core/GameState.js';

/** @typedef {object} RoomNode
 *  @property {string} roomId
 *  @property {string} name
 *  @property {string} region
 *  @property {number} x map grid cell x
 *  @property {number} y map grid cell y
 *  @property {boolean} discovered
 *  @property {boolean} isHidden secret room (hidden: true)
 *  @property {boolean} isSaveRoom
 *  @property {boolean} isTeleport teleport chamber
 *  @property {boolean} isBoss boss arena
 *  @property {boolean} hasUnexploredExit at least one exit to an undiscovered room
 */

/** @typedef {object} UnexploredDoor
 *  @property {string} from discovered room id
 *  @property {string} exitId
 *  @property {string} dir north|south|east|west|up|down
 *  @property {string} to undiscovered room id
 *  @property {string[]} requires ability ids gating the exit
 */

export class MapModel {
  /**
   * @param {object[]} [rooms] room defs (data/rooms.json shape)
   * @param {object} [options]
   * @param {object[]} [options.bosses] boss defs (arenaRoomId lookup)
   */
  constructor(rooms = [], options = {}) {
    /** @type {Map<string, object>} */
    this._rooms = new Map();
    /** @type {Set<string>} arena room ids */
    this._bossRooms = new Set();
    this.init(rooms, options);
  }

  /**
   * (Re)load room defs — used by the shared singleton once data is ready.
   * @param {object[]} rooms @param {object} [options]
   */
  init(rooms = [], options = {}) {
    this._rooms = new Map((rooms ?? []).map((r) => [r.id, r]));
    this._bossRooms = new Set(
      (options.bosses ?? []).map((b) => b.arenaRoomId).filter(Boolean),
    );
  }

  /** @param {string} roomId @returns {boolean} */
  isDiscovered(roomId) {
    return gameState.data.map.discovered.includes(roomId);
  }

  /** @param {string} roomId @returns {boolean} */
  isSecret(roomId) {
    return this._rooms.get(roomId)?.hidden === true;
  }

  /** @param {object} room @returns {boolean} non-secret rooms count toward completion */
  static countsTowardCompletion(room) {
    return room?.hidden !== true;
  }

  /**
   * Percent of non-secret rooms discovered, 0..100 (one decimal).
   * Secret rooms never count until found — per spec §27 a found secret
   * counts toward its room being discovered, not as a separate unit.
   * @returns {number}
   */
  getCompletion() {
    const countable = [...this._rooms.values()].filter(MapModel.countsTowardCompletion);
    if (countable.length === 0) return 0;
    const found = countable.filter((r) => this.isDiscovered(r.id)).length;
    return Math.round((found / countable.length) * 1000) / 10;
  }

  /**
   * Completion % for one region (non-secret rooms only). Regions with no
   * non-secret rooms report 100 (vacuously complete).
   * @param {string} region @returns {number} 0..100
   */
  getRegionCompletion(region) {
    const countable = [...this._rooms.values()].filter(
      (r) => r.region === region && MapModel.countsTowardCompletion(r),
    );
    if (countable.length === 0) return 100;
    const found = countable.filter((r) => this.isDiscovered(r.id)).length;
    return Math.round((found / countable.length) * 1000) / 10;
  }

  /** @returns {string[]} every region present in the loaded room defs */
  getRegions() {
    return [...new Set([...this._rooms.values()].map((r) => r.region))];
  }

  /**
   * Node descriptor for one room. Undiscovered secret rooms report
   * `discovered: false` and are never rendered (overlay contract).
   * @param {string} roomId @returns {RoomNode|null}
   */
  getRoomNode(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return null;
    const discovered = this.isDiscovered(roomId);
    return {
      roomId,
      name: room.name,
      region: room.region,
      x: room.map?.x ?? 0,
      y: room.map?.y ?? 0,
      discovered,
      isHidden: room.hidden === true,
      isSaveRoom: room.saveRoom === true,
      isTeleport: room.teleport === true,
      isBoss: this._bossRooms.has(roomId),
      hasUnexploredExit: (room.exits ?? []).some(
        (e) => !this.isDiscovered(e.target),
      ),
    };
  }

  /**
   * All discovered nodes for rendering. Hidden rooms appear only AFTER
   * discovery (secret rooms never render until found — spec §27).
   * @returns {RoomNode[]}
   */
  getDiscoveredNodes() {
    const out = [];
    for (const id of this._rooms.keys()) {
      if (!this.isDiscovered(id)) continue;
      out.push(this.getRoomNode(id));
    }
    return out;
  }

  /**
   * Record a room discovery. Mutation goes through gameState.discoverRoom()
   * (emits `map:roomDiscovered`); completion is recomputed and persisted via
   * gameState.setMapCompletion().
   * @param {string} roomId
   * @returns {number} new completion %
   */
  discover(roomId) {
    const room = this._rooms.get(roomId);
    gameState.discoverRoom(roomId, room?.region);
    const completion = this.getCompletion();
    gameState.setMapCompletion(completion);
    return completion;
  }

  /**
   * Exits from discovered rooms that lead to undiscovered rooms — rendered
   * as "unexplored door" markers on the overlay.
   * @returns {UnexploredDoor[]}
   */
  getUnexploredDoors() {
    const doors = [];
    for (const room of this._rooms.values()) {
      if (!this.isDiscovered(room.id)) continue;
      for (const e of room.exits ?? []) {
        if (this.isDiscovered(e.target)) continue;
        doors.push({
          from: room.id,
          exitId: e.id,
          dir: e.dir,
          to: e.target,
          requires: Array.isArray(e.requires) ? [...e.requires] : [],
        });
      }
    }
    return doors;
  }

  /**
   * Discovered-only special markers for the overlay.
   * @returns {{ save: RoomNode[], teleport: RoomNode[], boss: RoomNode[] }}
   */
  getMarkers() {
    const save = [];
    const teleport = [];
    const boss = [];
    for (const node of this.getDiscoveredNodes()) {
      if (node.isSaveRoom) save.push(node);
      if (node.isTeleport) teleport.push(node);
      if (node.isBoss) boss.push(node);
    }
    return { save, teleport, boss };
  }

  /**
   * Save rooms (discovered only) — lantern markers.
   * @returns {RoomNode[]}
   */
  getSaveRooms() {
    return this.getMarkers().save;
  }

  /**
   * Teleport chambers (discovered only).
   * @returns {RoomNode[]}
   */
  getTeleportRooms() {
    return this.getMarkers().teleport;
  }

  /**
   * Boss arenas (discovered only).
   * @returns {RoomNode[]}
   */
  getBossRooms() {
    return this.getMarkers().boss;
  }

  /**
   * Adjacent rooms of `roomId` that are still undiscovered — powers "fog
   * hints" without revealing secret rooms that were never entered.
   * @param {string} roomId @returns {RoomNode[]}
   */
  getUndiscoveredNeighbors(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return [];
    const out = [];
    for (const e of room.exits ?? []) {
      if (this.isDiscovered(e.target)) continue;
      const node = this.getRoomNode(e.target);
      if (node && !node.isHidden) out.push(node);
    }
    return out;
  }
}

/** Shared singleton — call `mapModel.init(rooms, { bosses })` once room data loads. */
export const mapModel = new MapModel();
