/**
 * UIScene — overlay scene for HUD and full-screen menus (Wave 5 builds the
 * actual screens here).
 *
 * Wave 1: pause-coordination skeleton per ARCHITECTURE §14 (ref-count).
 * Full screens emit `ui:opened { screen }` / `ui:closed { screen }` on the
 * event bus; GameScene tracks the count and pauses/resumes itself so closing
 * one screen never resumes the game while another is still open.
 *
 * UIScene also offers the imperative API (requestPause/releasePause) for
 * screens that prefer calling it directly — both paths funnel through the
 * same ref-count and the same events.
 */
import Phaser from 'phaser';
import { eventBus } from '../core/EventBus.js';
import { SceneKeys } from './index.js';

export class UIScene extends Phaser.Scene {
  constructor() {
    super({ key: SceneKeys.UI });
    /** @type {Set<string>} currently open full screens */
    this._openScreens = new Set();
  }

  create() {
    // Overlay is invisible until a screen draws into it. HUD/menus land in Wave 5.
  }

  /**
   * Open a full screen: pauses GameScene via ref-count, emits ui:opened.
   * @param {string} screen screen id (see ARCHITECTURE §14)
   */
  requestPause(screen) {
    if (this._openScreens.has(screen)) return;
    this._openScreens.add(screen);
    eventBus.emit('ui:opened', { screen });
  }

  /**
   * Close a full screen: resumes GameScene only when no other screen is open.
   * @param {string} screen screen id
   */
  releasePause(screen) {
    if (!this._openScreens.delete(screen)) return;
    eventBus.emit('ui:closed', { screen });
  }

  /** @returns {boolean} true while any full screen holds the pause */
  isPauseHeld() {
    return this._openScreens.size > 0;
  }
}
