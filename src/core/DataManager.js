/**
 * DataManager — bundled JSON content access (docs/ARCHITECTURE.md §17).
 *
 * All `data/*.json` files are imported statically so Vite bundles them into
 * the build (works offline, no fetch waterfall at boot). Treat returned
 * objects as READ-ONLY — never mutate them; GameState owns mutable state.
 *
 * API:
 *   dataManager.getData(name)  — 'weapons'|'armor'|'accessories'|
 *                                'consumables'|'enemies'|'bosses'|'merchants'|
 *                                'npcs'|'abilities'|'rooms'|'progression'
 *   dataManager.getRoom(roomId) — room object or null
 *
 * Validation: light, on first access per dataset (required top-level shape;
 * every array entry needs a string `id`). Full schema validation lives in
 * scripts/validate.js and runs in CI (`npm run validate`). A malformed
 * dataset throws a descriptive Error — BootScene surfaces it via the
 * friendly error screen (spec §59 crash protection).
 *
 * NOTE on the core/ dependency rule (ARCHITECTURE.md §1): this module
 * imports the JSON datasets directly in addition to ./EventBus.js. Static
 * JSON imports are data, not code dependencies — they are inlined by Vite
 * at build time and keep the game working offline with no runtime fetch.
 */
import weaponsData from '../../data/weapons.json';
import armorData from '../../data/armor.json';
import accessoriesData from '../../data/accessories.json';
import consumablesData from '../../data/consumables.json';
import merchantsData from '../../data/merchants.json';
import npcsData from '../../data/npcs.json';
import enemiesData from '../../data/enemies.json';
import bossesData from '../../data/bosses.json';
import abilitiesData from '../../data/abilities.json';
import roomsData from '../../data/rooms.json';
import progressionData from '../../data/progression.json';

/** Dataset names accepted by getData(). */
export const DATASET_NAMES = Object.freeze([
  'weapons',
  'armor',
  'accessories',
  'consumables',
  'enemies',
  'bosses',
  'merchants',
  'npcs',
  'abilities',
  'rooms',
  'progression',
]);

const DATASETS = {
  weapons: { data: weaponsData, kind: 'array' },
  armor: { data: armorData, kind: 'array' },
  accessories: { data: accessoriesData, kind: 'array' },
  consumables: { data: consumablesData, kind: 'array' },
  enemies: { data: enemiesData, kind: 'array' },
  bosses: { data: bossesData, kind: 'array' },
  merchants: { data: merchantsData, kind: 'array' },
  npcs: { data: npcsData, kind: 'array' },
  abilities: { data: abilitiesData, kind: 'array' },
  rooms: { data: roomsData, kind: 'array' },
  progression: {
    data: progressionData,
    kind: 'object',
    fields: ['levelCap', 'statGrowth', 'xpCurve'],
  },
};

/** @private light shape check; full schema validation is CI's job */
function validateDataset(name, def) {
  const { data, kind } = def;
  if (kind === 'array') {
    if (!Array.isArray(data)) {
      throw new Error(`[DataManager] dataset '${name}' must be a JSON array.`);
    }
    if (data.length === 0) {
      throw new Error(`[DataManager] dataset '${name}' is empty — expected at least one entry.`);
    }
    data.forEach((item, i) => {
      if (!item || typeof item.id !== 'string' || item.id.length === 0) {
        throw new Error(`[DataManager] dataset '${name}' entry ${i} is missing a string 'id'.`);
      }
    });
    return;
  }
  if (kind === 'object') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`[DataManager] dataset '${name}' must be a JSON object.`);
    }
    for (const field of def.fields ?? []) {
      if (!(field in data)) {
        throw new Error(`[DataManager] dataset '${name}' is missing required field '${field}'.`);
      }
    }
    return;
  }
  throw new Error(`[DataManager] dataset '${name}' has unknown kind '${kind}'.`);
}

export class DataManager {
  constructor() {
    /** @type {Set<string>} datasets already validated */
    this._validated = new Set();
  }

  /**
   * Get a whole dataset (read-only — do not mutate the result).
   * @param {string} name one of DATASET_NAMES
   * @returns {Array|object} the parsed JSON content
   * @throws {Error} unknown dataset name, or light validation failed
   */
  getData(name) {
    const def = DATASETS[name];
    if (!def) {
      throw new Error(
        `[DataManager] unknown dataset '${name}'. Known: ${DATASET_NAMES.join(', ')}.`
      );
    }
    if (!this._validated.has(name)) {
      validateDataset(name, def);
      this._validated.add(name);
    }
    return def.data;
  }

  /**
   * Find one room by id.
   * @param {string} roomId e.g. 'moonlit_gate_001'
   * @returns {object|null} the room object, or null when unknown
   */
  getRoom(roomId) {
    const rooms = this.getData('rooms');
    return rooms.find((r) => r.id === roomId) ?? null;
  }
}

/** Shared singleton. */
export const dataManager = new DataManager();
