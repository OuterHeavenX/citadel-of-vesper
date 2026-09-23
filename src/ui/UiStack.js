/**
 * UiStack — full-screen UI bookkeeping for ARCHITECTURE §14 pause ref-count.
 *
 * Wave 5 (W5-UI). Headless-safe: no Phaser import.
 *
 * CONTRACT:
 * - Screens (inventory, shop, dialogue, pause, gameover, victory) open and
 *   close through here. open() emits the catalog event `ui:opened {screen}`,
 *   close() emits `ui:closed {screen}`. GameScene's PauseCoordinator listens
 *   to those events, so opening any screen pauses the world and closing
 *   resumes ONLY when no other screen is open.
 * - open() is idempotent per screen id (re-opening a live screen is a no-op
 *   returning false). close() of a non-open screen is a no-op (false).
 * - closeAll() closes top-first so nested screens unwind in order.
 * - NOTE: MapOverlay and SaveSanctum/TeleportChamber emit ui:opened/ui:closed
 *   themselves (their own modules own those emissions) — they are NOT tracked
 *   here. UiStack covers only the Wave 5 screens GameScene opens directly.
 */
import { eventBus } from '../core/EventBus.js';

export class UiStack {
  /**
   * @param {object} [deps]
   * @param {object} [deps.bus] EventBus-like (injectable for tests)
   */
  constructor({ bus = eventBus } = {}) {
    this.bus = bus;
    /** @type {string[]} bottom -> top */
    this._stack = [];
    /** @type {Map<string, Function>} teardown callbacks per screen */
    this._onClose = new Map();
  }

  /**
   * Open a full screen.
   * @param {string} screen screen id
   * @param {object} [opts] @param {Function} [opts.onClose] teardown callback
   * @returns {boolean} true when the screen actually opened
   */
  open(screen, { onClose } = {}) {
    if (typeof screen !== 'string' || screen.length === 0) return false;
    if (this._stack.includes(screen)) return false;
    this._stack.push(screen);
    if (typeof onClose === 'function') this._onClose.set(screen, onClose);
    this.bus.emit('ui:opened', { screen });
    return true;
  }

  /**
   * Close a full screen.
   * @param {string} screen screen id
   * @returns {boolean} true when the screen was open and closed
   */
  close(screen) {
    const idx = this._stack.lastIndexOf(screen);
    if (idx === -1) return false;
    this._stack.splice(idx, 1);
    const cb = this._onClose.get(screen);
    this._onClose.delete(screen);
    if (cb) {
      try {
        cb();
      } catch (err) {
        console.error(`[UiStack] onClose for '${screen}' threw:`, err);
      }
    }
    this.bus.emit('ui:closed', { screen });
    return true;
  }

  /** Close the top-most screen. @returns {string|null} the screen closed */
  closeTop() {
    const top = this.top();
    if (top == null) return null;
    this.close(top);
    return top;
  }

  /** Close every tracked screen, top-first. */
  closeAll() {
    for (const screen of [...this._stack].reverse()) this.close(screen);
  }

  /** @returns {string|null} top-most open screen */
  top() {
    return this._stack.length ? this._stack[this._stack.length - 1] : null;
  }

  /** @param {string} screen @returns {boolean} */
  isOpen(screen) {
    return this._stack.includes(screen);
  }

  /** @returns {number} open screen count */
  count() {
    return this._stack.length;
  }

  /** @returns {string[]} open screens, bottom -> top */
  list() {
    return [...this._stack];
  }
}
