/**
 * src/items — items, inventory, equipment. Public API surface:
 *
 *   ItemData.js  class ItemData — unified registry over data/*.json item files
 *
 * Inventory state lives in GameState (addItem/removeItem/equip/unequip).
 * UI comparison values come from weapons/WeaponData.compare().
 */
export { ItemData, getItemData } from './ItemData.js';
