/**
 * EquipmentManager — equip/unequip + compare (Wave 4).
 *
 * CONTRACT:
 * - Slot resolution: weapons -> 'weapon'; armor -> def.slot; accessories ->
 *   def.slot ?? first free accessory slot ('accessory1'|'accessory2').
 *   Items with no resolvable slot (consumables, quest items, ...) are not
 *   equippable.
 * - equip() moves one unit from inventory into the slot and returns the
 *   previously equipped item to inventory; unequip() reverses it. Both go
 *   through GameState.equip/unequip so `item:equipped` / `item:unequipped` /
 *   `inventory:changed` flow and PlayerStats.recalc() runs downstream.
 * - compareToEquipped() feeds the shop/inventory compare UI: weapons use
 *   WeaponData.compare(); armor/accessories return raw stat + resistance
 *   deltas vs the item currently in the resolved slot.
 * - 'equipment:changed' is NOT in the EventBus catalog (checked
 *   src/core/EventBus.js, 2026-09-23); equipment changes are announced via
 *   the catalog's `item:equipped` / `item:unequipped` / `inventory:changed`.
 *
 * Wave 5 wiring: UI calls equip()/unequip()/compareToEquipped() directly;
 * no scene changes needed.
 */
import { gameState } from '../core/GameState.js';
import { dataManager } from '../core/DataManager.js';
import { getItemData } from '../items/ItemData.js';
import { WeaponData } from '../weapons/WeaponData.js';

const ACCESSORY_SLOTS = Object.freeze(['accessory1', 'accessory2']);
const EQUIPPABLE_CATEGORIES = new Set(['weapon', 'armor', 'accessory']);

export class EquipmentManager {
  /**
   * @param {object} [deps]
   * @param {object} [deps.state] GameState singleton (injectable for tests)
   */
  constructor({ state = gameState } = {}) {
    this.state = state;
    this._items = getItemData();
    this._weapons = new WeaponData(dataManager.getData('weapons'));
  }

  /**
   * Resolve the equipment slot for an item.
   * @param {string} itemId @returns {string|null} slot or null when not equippable
   */
  resolveSlot(itemId) {
    let def;
    try {
      def = this._items.get(itemId);
    } catch {
      return null;
    }
    if (!EQUIPPABLE_CATEGORIES.has(def.category)) return null;
    if (def.category === 'weapon') return 'weapon';
    if (def.slot) return def.slot;
    if (def.category === 'accessory') {
      const eq = this.state.data.equipment;
      return ACCESSORY_SLOTS.find((s) => !eq[s]) ?? 'accessory1';
    }
    return null;
  }

  /** @returns {Record<string, object|null>} slot -> equipped item def (or null) */
  getEquipped() {
    const out = {};
    for (const [slot, itemId] of Object.entries(this.state.data.equipment)) {
      out[slot] = itemId ? this._items.get(itemId) : null;
    }
    return out;
  }

  /**
   * Equip one unit of an item from inventory.
   * @param {string} itemId
   * @param {object} [opts] @param {string} [opts.slot] explicit slot (accessories)
   * @returns {{ok:boolean, reason?:string, slot?:string, previous?:string|null}}
   */
  equip(itemId, { slot = null } = {}) {
    let def;
    try {
      def = this._items.get(itemId);
    } catch {
      return { ok: false, reason: 'unknown_item' };
    }
    const resolved = slot ?? this.resolveSlot(itemId);
    if (!resolved) return { ok: false, reason: 'not_equippable' };
    if (def.category === 'weapon' && resolved !== 'weapon') {
      return { ok: false, reason: 'wrong_slot' };
    }
    if (def.category === 'armor' && def.slot && resolved !== def.slot) {
      return { ok: false, reason: 'wrong_slot' };
    }
    if (def.category === 'accessory' && !ACCESSORY_SLOTS.includes(resolved)) {
      return { ok: false, reason: 'wrong_slot' };
    }
    if (this.state.countItem(itemId) < 1) return { ok: false, reason: 'not_in_inventory' };

    this.state.removeItem(itemId, 1);
    const previous = this.state.data.equipment[resolved] ?? null;
    if (previous) this.state.addItem(previous, 1);
    this.state.equip(resolved, itemId);
    return { ok: true, slot: resolved, previous };
  }

  /**
   * Unequip a slot back into inventory.
   * @param {string} slot
   * @returns {{ok:boolean, reason?:string, itemId?:string}}
   */
  unequip(slot) {
    let current;
    try {
      current = this.state.data.equipment[slot] ?? null;
    } catch {
      return { ok: false, reason: 'unknown_slot' };
    }
    if (!(slot in this.state.data.equipment)) return { ok: false, reason: 'unknown_slot' };
    if (!current) return { ok: false, reason: 'slot_empty' };
    this.state.unequip(slot);
    this.state.addItem(current, 1);
    return { ok: true, itemId: current };
  }

  /**
   * Compare a candidate item against what is currently equipped in its slot.
   * @param {string} itemId
   * @returns {{ok:boolean, reason?:string, slot?:string, equippedId?:string|null,
   *   atkDelta?:number, statDeltas?:object, speedDelta?:number, critDelta?:number,
   *   resistanceDeltas?:object}}
   */
  compareToEquipped(itemId) {
    let def;
    try {
      def = this._items.get(itemId);
    } catch {
      return { ok: false, reason: 'unknown_item' };
    }
    const slot = this.resolveSlot(itemId);
    if (!slot) return { ok: false, reason: 'not_equippable' };
    const equippedId = this.state.data.equipment[slot] ?? null;

    if (def.category === 'weapon') {
      return {
        ok: true,
        slot,
        equippedId,
        ...this._weapons.compare(itemId, equippedId),
      };
    }
    const stat = (d, k) => d?.stats?.[k] ?? 0;
    const res = (d, t) => d?.resistances?.[t] ?? 0;
    const eqDef = equippedId ? this._items.get(equippedId) : null;
    const statDeltas = {};
    for (const k of new Set([...Object.keys(def.stats ?? {}), ...Object.keys(eqDef?.stats ?? {})])) {
      const d = stat(def, k) - stat(eqDef, k);
      if (d !== 0) statDeltas[k] = d;
    }
    const resistanceDeltas = {};
    for (const t of new Set([...Object.keys(def.resistances ?? {}), ...Object.keys(eqDef?.resistances ?? {})])) {
      const d = res(def, t) - res(eqDef, t);
      if (d !== 0) resistanceDeltas[t] = Math.round(d * 1000) / 1000;
    }
    return { ok: true, slot, equippedId, statDeltas, resistanceDeltas };
  }
}

/** Shared singleton (GameScene / UI use this instance). */
export const equipmentManager = new EquipmentManager();
