/**
 * NpcDirector — NPC presence per room + interact prompt (Wave 5, W5-UI).
 *
 * Headless-safe: no Phaser import. Scene sprites are created through an
 * injected `spawnSprite(npc)` / `despawnSprite(handle)` pair, so node tests
 * use fakes while GameScene supplies the Phaser implementation.
 *
 * CONTRACT:
 * - onRoomChanged(roomId): despawns the old room's NPCs, spawns one Npc
 *   model per npc currently in the room (DialogueManager.npcsInRoom —
 *   honors flag-based relocation).
 * - update(): proximity check against the player position. When the player
 *   is within INTERACT_RADIUS of an NPC and no full screen is open, the
 *   director shows the TALK prompt (no auto-freeze — per the standing
 *   interaction rule, dialogue opens only on confirm).
 * - Interact binding follows W3-ABILITIES's convention (SaveSanctum):
 *   `confirm` OR `move_up` while the prompt is visible opens dialogue via
 *   the injected onInteract(npc) callback. GameScene opens the dialogue UI
 *   there (and the shop UI afterwards for merchant NPCs).
 * - Merchant NPCs get a gold-tinted marker so players can spot shops.
 */
import { dialogueManager as sharedDialogueManager } from '../../systems/DialogueManager.js';
import { Npc } from '../../npcs/Npc.js';

export const INTERACT_RADIUS = 52;

/**
 * @typedef {object} NpcDirectorDeps
 * @property {object} [input] InputManager-like { justPressed }
 * @property {object} [dialogue] DialogueManager-like
 * @property {Function} [getPlayerPos] () -> { x, y } | null
 * @property {Function} [spawnSprite] (npc) -> handle (or null)
 * @property {Function} [despawnSprite] (handle, npc) -> void
 * @property {Function} [showPrompt] (npc, x, y) -> void
 * @property {Function} [hidePrompt] () -> void
 * @property {Function} [isUiOpen] () -> boolean (suppress prompt/interact)
 * @property {Function} [onInteract] (npc) -> void
 */
export class NpcDirector {
  /**
   * @param {NpcDirectorDeps} [deps]
   */
  constructor(deps = {}) {
    this.input = deps.input ?? null;
    this.dialogue = deps.dialogue ?? sharedDialogueManager;
    this.getPlayerPos = deps.getPlayerPos ?? (() => null);
    this.spawnSprite = deps.spawnSprite ?? (() => null);
    this.despawnSprite = deps.despawnSprite ?? (() => {});
    this.showPrompt = deps.showPrompt ?? (() => {});
    this.hidePrompt = deps.hidePrompt ?? (() => {});
    this.isUiOpen = deps.isUiOpen ?? (() => false);
    this.onInteract = deps.onInteract ?? (() => {});
    /** @type {{ npc: Npc, handle: * }[]} */
    this._present = [];
    /** @type {Npc|null} npc currently prompting */
    this._promptNpc = null;
    this._roomId = null;
  }

  /** @returns {string|null} current room id */
  get roomId() {
    return this._roomId;
  }

  /** @returns {Npc[]} live NPC models in the current room */
  get present() {
    return this._present.map((p) => p.npc);
  }

  /**
   * Rebuild presence for a room (call on room:changed).
   * @param {string} roomId
   */
  onRoomChanged(roomId) {
    this._clearPrompt();
    for (const { npc, handle } of this._present) {
      try {
        this.despawnSprite(handle, npc);
      } catch {
        /* teardown edge — ignore */
      }
    }
    this._present = [];
    this._roomId = roomId;
    if (!roomId) return;
    let defs = [];
    try {
      defs = this.dialogue.npcsInRoom(roomId);
    } catch {
      defs = [];
    }
    for (const def of defs) {
      let npc;
      try {
        npc = new Npc(null, def, { dialogueManager: this.dialogue });
      } catch {
        continue;
      }
      let handle = null;
      try {
        handle = this.spawnSprite(npc);
      } catch {
        handle = null;
      }
      this._present.push({ npc, handle });
    }
  }

  /**
   * Per-frame: proximity prompt + interact. Call before the pause gate so
   * the prompt stays live while the world runs.
   */
  update() {
    if (!this.input || this.isUiOpen()) {
      this._clearPrompt();
      return;
    }
    const pos = this.getPlayerPos();
    if (!pos) {
      this._clearPrompt();
      return;
    }
    let nearest = null;
    let nearestD2 = INTERACT_RADIUS * INTERACT_RADIUS;
    for (const { npc } of this._present) {
      const loc = npc.getLocation();
      const nx = loc.x ?? 0;
      const ny = loc.y ?? 0;
      const dx = pos.x - nx;
      const dy = pos.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 <= nearestD2) {
        nearest = npc;
        nearestD2 = d2;
      }
    }
    if (!nearest) {
      this._clearPrompt();
      return;
    }
    if (this._promptNpc !== nearest) {
      this._promptNpc = nearest;
      const loc = nearest.getLocation();
      this.showPrompt(nearest, loc.x ?? 0, loc.y ?? 0);
    }
    // W3-ABILITIES interact convention: confirm OR move_up while prompting.
    const pressed = (a) => {
      try {
        return this.input.justPressed(a) === true;
      } catch {
        return false;
      }
    };
    if (pressed('confirm') || pressed('move_up')) {
      const npc = nearest;
      this._clearPrompt();
      this.onInteract(npc);
    }
  }

  /** Remove all NPCs (scene shutdown). */
  destroy() {
    this._clearPrompt();
    for (const { npc, handle } of this._present) {
      try {
        this.despawnSprite(handle, npc);
      } catch {
        /* ignore */
      }
    }
    this._present = [];
    this._roomId = null;
  }

  /** @private */
  _clearPrompt() {
    if (this._promptNpc) {
      this._promptNpc = null;
      try {
        this.hidePrompt();
      } catch {
        /* ignore */
      }
    }
  }
}
