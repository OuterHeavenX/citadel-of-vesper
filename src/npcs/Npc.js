/**
 * Npc — recurring characters (Wave 4; spec §47).
 *
 * CONTRACT:
 * - Data-driven from data/npcs.json: { id, name, title, portrait, roomId,
 *   x, y, merchantId?, relocate?, dialogue }.
 * - This class is the headless-safe NPC model: identity, location (with
 *   flag-based relocation via DialogueManager.getLocation), and interact().
 * - interact() delegates to a DialogueManager (emits the catalog event
 *   `npc:dialogueOpened`); when the NPC has a merchantId the SHOP UI
 *   (Wave 5) opens after/around dialogue — the merchant itself is
 *   constructed via getMerchant().
 * - Scene sprites, idle animation, and the Phaser interact prompt are
 *   Wave 5 (this constructor accepts scene=null for headless use).
 *
 * Wave 5 wiring: GameScene spawns one Npc per npc in the current room
 * (DialogueManager.npcsInRoom(roomId)), attaches sprites, and calls
 * interact() on the interact action.
 */
import { dataManager } from '../core/DataManager.js';
import { gameState } from '../core/GameState.js';
import { dialogueManager as sharedDialogueManager } from '../systems/DialogueManager.js';
import { Merchant } from './Merchant.js';

export class Npc {
  /**
   * @param {Phaser.Scene|null} scene null => headless
   * @param {object|string} defOrId npc definition object or npc id
   * @param {object} [deps]
   * @param {object} [deps.dialogueManager] DialogueManager instance
   */
  constructor(scene, defOrId, { dialogueManager = sharedDialogueManager } = {}) {
    const def =
      typeof defOrId === 'string'
        ? dataManager.getData('npcs').find((n) => n.id === defOrId)
        : defOrId;
    if (!def) throw new Error(`unknown npc '${defOrId}'`);
    this.scene = scene;
    this.def = def;
    this.dialogue = dialogueManager;
    this.state = gameState;
    /** @type {object|null} scene sprite (attached by Wave 5) */
    this.sprite = null;
  }

  /** @returns {string} */
  get id() {
    return this.def.id;
  }

  /** @returns {string} */
  get name() {
    return this.def.name;
  }

  /** @returns {boolean} true when this NPC runs a shop */
  get isMerchant() {
    return !!this.def.merchantId;
  }

  /**
   * Current location, honoring flag-based relocation.
   * @returns {{roomId:string, x:number|null, y:number|null}}
   */
  getLocation() {
    return this.dialogue.getLocation(this.def.id);
  }

  /** @returns {Merchant} the shop behind this NPC (throws when not a merchant) */
  getMerchant() {
    if (!this.isMerchant) throw new Error(`npc '${this.def.id}' is not a merchant`);
    return new Merchant(this.def.merchantId, { state: this.state });
  }

  /**
   * Open dialogue (emits `npc:dialogueOpened` via the DialogueManager).
   * The dialogue UI (Wave 5) renders the returned node view.
   * @returns {object} node view { npcId, npcName, nodeId, text, choices }
   */
  interact() {
    return this.dialogue.open(this.def.id);
  }

  /** @param {number} dt seconds (Wave 5: idle animation) */
  update(dt) {
    // No-op until the presentation wave attaches sprites.
  }

  destroy() {
    this.sprite = null;
  }
}
