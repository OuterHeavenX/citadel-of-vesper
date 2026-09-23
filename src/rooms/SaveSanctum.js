/**
 * SaveSanctum — save-room rest sequence (spec §30; ROOM_FORMAT.md saveRoom).
 *
 * CONTRACT (W3-ROOMS / W3-GAME):
 * - RoomManager (owned by W3-ROOMS) MUST call `saveSanctum.activate(room)`
 *   when the player enters a room with `saveRoom: true`, and should call
 *   `saveSanctum.update()` once per frame while it is active (GameScene
 *   update is fine). On room exit it should call `saveSanctum.deactivate()`.
 *   Requested RoomManager addition: `this.onSaveRoom?.(room)` after loadRoom
 *   completes for save rooms — W3-ABILITIES provides this module, W3-ROOMS
 *   owns the hook.
 * - INTERACT BINDING: there is no 'interact' action in InputManager's Actions
 *   catalog. This module treats `confirm` (Enter/Space/J, gamepad A) OR
 *   `move_up` (W/Up, dpad-up) as "use the shrine" while the prompt is shown.
 *   If a dedicated 'interact' action is added later, pass it via
 *   `new SaveSanctum({ interactAction: 'interact' })`.
 * - Flow: prompt → confirm → full heal (gameState.rest() emits
 *   'player:healed'; this module then emits 'save:rested' { roomId } per the
 *   event catalog) + lantern-lighting FX hook → slot select 1–3 →
 *   saveManager.write(slot, gameState.toJSON()) ('game:saved' is emitted by
 *   SaveManager itself).
 * - UI is deliberately minimal text via an injected `render(state)` callback
 *   (Wave 5 restyles). Fully keyboard+gamepad operable: move_up/move_down
 *   change slot, confirm writes, cancel backs out.
 * - Phaser-free logic: all rendering is delegated to `render`.
 */

import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { inputManager } from '../core/InputManager.js';
import { saveManager } from '../core/SaveManager.js';

export const SAVE_SLOTS = [1, 2, 3];

/**
 * @typedef {object} SanctumViewState
 * @property {'prompt'|'slots'|'done'} mode
 * @property {number} slot selected slot (1–3)
 * @property {string|null} message status line ('saved', 'error: …', null)
 * @property {string} roomId
 */

export class SaveSanctum {
  /**
   * @param {object} [deps]
   * @param {object} [deps.gameState] @param {object} [deps.eventBus]
   * @param {object} [deps.inputManager] @param {object} [deps.saveManager]
   * @param {Function} [deps.render] (state: SanctumViewState) => void — minimal text UI
   * @param {string} [deps.interactAction] action that begins rest ('confirm' default)
   * @param {Function} [deps.getPlayerPosition] () => { roomId, x, y } | null —
   *   live player position, synced into gameState before writing the save
   *   (gameState.position otherwise goes stale mid-room).
   */
  constructor(deps = {}) {
    this.gameState = deps.gameState ?? gameState;
    this.events = deps.eventBus ?? eventBus;
    this.input = deps.inputManager ?? inputManager;
    this.saves = deps.saveManager ?? saveManager;
    this.render = deps.render ?? (() => {});
    this.interactAction = deps.interactAction ?? 'confirm';
    this.getPlayerPosition = deps.getPlayerPosition ?? null;

    /** Lantern-lighting visual hook (pale flame over the shrine); no-op default. */
    this._lanternFx = () => {};

    this.active = false;
    this.roomId = null;
    this.mode = 'prompt';
    this.slot = 1;
    this.message = null;
  }

  /** Wave 5: inject the lantern-lighting visual (pale flame, glow). */
  setLanternFx(fn) {
    this._lanternFx = typeof fn === 'function' ? fn : () => {};
  }

  /**
   * Begin the sanctum sequence for a save room. Called by RoomManager
   * (W3-ROOMS) via `roomManager.onSaveRoom = (room) => saveSanctum.activate(room)`.
   * @param {{ id?: string, roomId?: string }} room room data or Room instance
   *   (Room exposes .roomId, plain defs expose .id — accept both).
   */
  activate(room) {
    this.roomId = room?.roomId ?? room?.id ?? null;
    this.active = true;
    this.mode = 'prompt';
    this.slot = 1;
    this.message = null;
    this._draw();
  }

  /** Leave the sequence (room exit). */
  deactivate() {
    this.active = false;
    this.roomId = null;
    this.mode = 'prompt';
    this.message = null;
    this._draw(); // hide the prompt via render
  }

  /** @returns {boolean} */
  isActive() {
    return this.active;
  }

  /**
   * Advance the sequence; call once per frame while active.
   * Polls the input facade (keyboard + gamepad + touch all drive actions).
   */
  update() {
    if (!this.active) return;
    const pressed = (a) => this.input.justPressed(a);
    const interact =
      pressed(this.interactAction) ||
      (this.interactAction !== 'move_up' && pressed('move_up'));

    if (this.mode === 'prompt') {
      if (interact) void this._rest();
      else if (pressed('cancel')) this.deactivate();
    } else if (this.mode === 'slots') {
      if (pressed('move_up')) {
        this.slot = this.slot > 1 ? this.slot - 1 : SAVE_SLOTS.length;
        this._draw();
      } else if (pressed('move_down')) {
        this.slot = (this.slot % SAVE_SLOTS.length) + 1;
        this._draw();
      } else if (pressed(this.interactAction)) void this._save();
      else if (pressed('cancel')) {
        this.mode = 'prompt';
        this._draw();
      }
    } else if (this.mode === 'done') {
      if (pressed(this.interactAction) || pressed('cancel')) {
        this.mode = 'prompt';
        this.message = null;
        this._draw();
      }
    }
  }

  /** Rest: full HP/MP heal + save:rested + lantern FX, then slot select. */
  async _rest() {
    this.gameState.rest(); // emits 'player:healed'
    this.events.emit('save:rested', { roomId: this.roomId });
    try {
      await this._lanternFx(this.roomId);
    } catch {
      /* FX must never break the sequence */
    }
    this.mode = 'slots';
    this._draw();
  }

  /** Write the current state to the selected slot. */
  async _save() {
    // W6-QA: gameState.position is only synced on save/rest — snapshot the
    // live player position first, or CONTINUE restores a stale room.
    try {
      const pos = this.getPlayerPosition?.();
      if (pos && pos.roomId && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        this.gameState.setPosition(pos.roomId, pos.x, pos.y);
      }
    } catch {
      /* position snapshot is best-effort; the write below still happens */
    }
    const res = await this.saves.write(this.slot, this.gameState.toJSON());
    // SaveManager emits 'game:saved' { slot, playTime } on success.
    this.message = res.ok ? `Saved to slot ${this.slot}.` : `Save failed: ${res.error}`;
    this.mode = 'done';
    this._draw();
  }

  /** @private */
  _draw() {
    this.render({
      mode: this.mode,
      slot: this.slot,
      message: this.message,
      roomId: this.roomId,
    });
  }
}
