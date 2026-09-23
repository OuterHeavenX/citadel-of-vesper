/**
 * TeleportChamber — teleport-room discover + travel (spec §31; ROOM_FORMAT.md teleport).
 *
 * CONTRACT (W3-ROOMS / W3-GAME):
 * - Constructed ONCE per game with the RoomManager back-reference:
 *     `const teleportChamber = new TeleportChamber(roomManager);`
 * - RoomManager (owned by W3-ROOMS) MUST call `teleportChamber.bind(room)`
 *   when the player enters a room with `teleport: true`. Requested
 *   RoomManager addition: `this.onTeleportRoom?.(room)` after loadRoom
 *   completes for teleport rooms — W3-ABILITIES provides this module,
 *   W3-ROOMS owns the hook. bind() is idempotent across re-entries.
 * - Call `teleportChamber.update()` once per frame while active (GameScene
 *   update is fine); call `teleportChamber.deactivate()` on room exit.
 * - INTERACT BINDING: same convention as SaveSanctum — `confirm`
 *   (Enter/Space/J, gamepad A) OR `move_up` begins interaction while the
 *   prompt is shown (no 'interact' action exists in InputManager's Actions).
 *   Override with `new TeleportChamber(rm, { interactAction: 'interact' })`.
 * - Flow: bind(room) → gameState.discoverTeleport(chamberId) (idempotent;
 *   emits 'teleport:discovered' { chamberId } on first discovery) → prompt →
 *   interact → list of discovered chambers (excluding the current one) →
 *   confirm → roomManager.loadRoom(target) → gameState.useTeleport(from, to)
 *   (emits 'teleport:used' { from, to }).
 * - UI is minimal text via an injected `render(state)` callback (Wave 5
 *   restyles). Keyboard+gamepad: move_up/move_down move the cursor, confirm
 *   travels, cancel backs out.
 * - Phaser-free logic: all rendering is delegated to `render`.
 */

import { gameState } from '../core/GameState.js';
import { inputManager } from '../core/InputManager.js';

export class TeleportChamber {
  /**
   * @param {object} roomManager RoomManager-like { loadRoom(roomId, spawnHint?) }
   * @param {object} [deps]
   * @param {object} [deps.gameState] @param {object} [deps.inputManager]
   * @param {Function} [deps.render] (state: ChamberViewState) => void
   * @param {string} [deps.interactAction] action that begins travel ('confirm' default)
   */
  constructor(roomManager, deps = {}) {
    if (!roomManager || typeof roomManager.loadRoom !== 'function') {
      throw new Error('TeleportChamber requires a roomManager with loadRoom(roomId)');
    }
    this.roomManager = roomManager;
    this.gameState = deps.gameState ?? gameState;
    this.input = deps.inputManager ?? inputManager;
    this.render = deps.render ?? (() => {});
    this.interactAction = deps.interactAction ?? 'confirm';

    this.active = false;
    /** @type {string|null} chamber the player is currently standing in */
    this.from = null;
    this.mode = 'prompt'; // prompt | select
    this.targets = [];
    this.cursor = 0;
  }

  /**
   * Register entry into a teleport:true room. Discovers the chamber on
   * first entry; shows the travel prompt on every entry.
   * @param {{ id?: string, roomId?: string }} room room data or Room instance
   *   (Room exposes .roomId, plain defs expose .id — accept both).
   */
  bind(room) {
    const id = room?.roomId ?? room?.id ?? null;
    this.from = id;
    this.gameState.discoverTeleport(id); // emits teleport:discovered (first time)
    this.active = true;
    this.mode = 'prompt';
    this._draw();
  }

  /** Leave the chamber UI (room exit). */
  deactivate() {
    this.active = false;
    this.from = null;
    this.mode = 'prompt';
    this.targets = [];
    this._draw(); // hide the prompt via render
  }

  /** @returns {boolean} */
  isActive() {
    return this.active;
  }

  /** @returns {string[]} discovered chamber ids excluding the current one */
  getTargets() {
    return this.gameState.data.teleports.filter((id) => id !== this.from);
  }

  /**
   * Advance the UI; call once per frame while active.
   * Polls the input facade (keyboard + gamepad + touch all drive actions).
   */
  update() {
    if (!this.active) return;
    const pressed = (a) => this.input.justPressed(a);
    const interact =
      pressed(this.interactAction) ||
      (this.interactAction !== 'move_up' && pressed('move_up'));

    if (this.mode === 'prompt') {
      if (interact) this._open();
      else if (pressed('cancel')) this.deactivate();
    } else if (this.mode === 'select') {
      if (pressed('move_up')) {
        this.cursor = (this.cursor - 1 + this.targets.length) % this.targets.length;
        this._draw();
      } else if (pressed('move_down')) {
        this.cursor = (this.cursor + 1) % this.targets.length;
        this._draw();
      } else if (pressed(this.interactAction)) {
        // W6-QA: no discovered destinations (other than this chamber) —
        // travel would loadRoom(undefined). Stay in select mode.
        if (this.targets.length) void this._travel(this.targets[this.cursor]);
      } else if (pressed('cancel')) {
        this.mode = 'prompt';
        this._draw();
      }
    }
  }

  /** @private open the destination list */
  _open() {
    this.targets = this.getTargets();
    this.cursor = 0;
    this.mode = 'select';
    this._draw();
  }

  /** @private travel to the chosen chamber */
  async _travel(to) {
    const from = this.from;
    await this.roomManager.loadRoom(to);
    this.gameState.useTeleport(from, to); // emits 'teleport:used' { from, to }
    // The destination room's bind() (via RoomManager's onTeleportRoom hook)
    // re-activates this chamber for the new room; clear local UI meanwhile.
    this.mode = 'prompt';
    this.targets = [];
  }

  /** @private */
  _draw() {
    this.render({
      mode: this.mode,
      from: this.from,
      targets: this.targets,
      cursor: this.cursor,
    });
  }
}
