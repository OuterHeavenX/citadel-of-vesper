/**
 * ItemData — unified item registry (spec §19, §20).
 *
 * CONTRACT:
 * - Merges data/weapons.json, armor.json, accessories.json, consumables.json
 *   into one id->definition map. Categories: weapon|armor|accessory|
 *   consumable|quest|relic|key|material.
 * - get(id): any item; getSlot(id): equipment slot or null.
 * - Equipment slots (fixed): weapon|offhand|head|body|accessory1|accessory2.
 * - Item schema: { id, name, category, slot?, stats:{}, description,
 *   flavor?, rarity, value, icon } — see data/schemas/item.schema.json.
 * - Consumables: { effect: { heal?, mana?, ... }, usableInCombat }.
 * - Quest/key/relic items: never sold or dropped accidentally (soulbound flag).
 *
 * Wave 2 extension (W2-PLAYER): `has(id)` safe lookup + `getItemData()`
 * shared singleton built from DataManager datasets, so PlayerStats can
 * resolve equipment bonuses without its own JSON loading.
 */
import { dataManager } from '../core/DataManager.js';

export class ItemData {
  /** @param {object} tables { weapons:[], armor:[], accessories:[], consumables:[] } */
  constructor(tables = {}) {
    this.byId = new Map();
    for (const list of Object.values(tables)) {
      for (const item of list ?? []) this.byId.set(item.id, item);
    }
  }

  /** @param {string} id @returns {boolean} */
  has(id) {
    return this.byId.has(id);
  }

  /** @param {string} id @returns {object} throws on unknown id */
  get(id) {
    const item = this.byId.get(id);
    if (!item) throw new Error(`unknown item id '${id}'`);
    return item;
  }

  /** @param {string} id @returns {string|null} equipment slot or null */
  getSlot(id) {
    return this.get(id).slot ?? null;
  }

  /** @param {string} category @returns {object[]} */
  listByCategory(category) {
    return [...this.byId.values()].filter((i) => i.category === category);
  }
}

/** @type {ItemData|null} lazily-built shared registry */
let _shared = null;

/**
 * Shared ItemData registry over the bundled item datasets.
 * Built once from DataManager (static JSON imports — works offline).
 * @returns {ItemData}
 */
export function getItemData() {
  if (!_shared) {
    _shared = new ItemData({
      weapons: dataManager.getData('weapons'),
      armor: dataManager.getData('armor'),
      accessories: dataManager.getData('accessories'),
      consumables: dataManager.getData('consumables'),
    });
  }
  return _shared;
}
