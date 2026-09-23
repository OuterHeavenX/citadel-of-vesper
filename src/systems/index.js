/**
 * src/systems — Wave 4 progression / economy / NPC systems (headless-safe).
 *
 *   InventoryManager.js  inventory model + consumable use (heal/mana/buff/cure)
 *   EquipmentManager.js  equip/unequip + equipped-vs-candidate compare
 *   DialogueManager.js   data-driven NPC dialogue trees + flag variants
 *   Bestiary.js          enemy/boss codex fed by 'enemy:died'
 *   storyFlags.js        initStoryFlags(): boss/secret -> gameState flags
 *
 * GameScene wiring (Wave 5): construct/use the singletons, call
 * bestiary.init() + initStoryFlags() once at boot, and pass the live Player
 * into inventoryManager.useItem(id, { player }).
 */
export { InventoryManager, inventoryManager } from './InventoryManager.js';
export { EquipmentManager, equipmentManager } from './EquipmentManager.js';
export { DialogueManager, dialogueManager } from './DialogueManager.js';
export { Bestiary, bestiary } from './Bestiary.js';
export { initStoryFlags } from './storyFlags.js';
