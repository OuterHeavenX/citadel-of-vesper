/**
 * Bestiary — enemy/boss codex (Wave 4).
 *
 * CONTRACT:
 * - Subscribes to the catalog's `enemy:died` and routes kills into
 *   gameState.recordBestiaryKill() (serializable: { seen, kills } per id).
 * - `boss:encounterStarted` marks the boss seen; `boss:died` records the kill.
 * - getBestiary() joins kill data with data/enemies.json + data/bosses.json
 *   (name, title, ORIGINAL lore blurbs written for this game).
 * - Headless-safe. init() is idempotent; destroy() unsubscribes (tests).
 *
 * Wave 5 wiring: GameScene calls bestiary.init() once at boot; the BESTIARY
 * inventory tab reads getBestiary().
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { dataManager } from '../core/DataManager.js';

export class Bestiary {
  /**
   * @param {object} [deps]
   * @param {object} [deps.state] GameState singleton (injectable for tests)
   */
  constructor({ state = gameState } = {}) {
    this.state = state;
    this._enemies = dataManager.getData('enemies');
    this._bosses = dataManager.getData('bosses');
    this._unsubs = [];
    this._initialized = false;
  }

  /** Subscribe to kill/encounter events (idempotent). */
  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._unsubs = [
      eventBus.on('enemy:died', ({ enemyId }) => {
        this.state.recordBestiaryKill(enemyId);
      }),
      eventBus.on('boss:encounterStarted', ({ bossId }) => {
        this.state.markBestiarySeen(bossId);
      }),
      eventBus.on('boss:died', ({ bossId }) => {
        this.state.recordBestiaryKill(bossId);
      }),
    ];
  }

  /** Unsubscribe (tests / teardown). */
  destroy() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._initialized = false;
  }

  /**
   * @returns {{id, kind:'enemy'|'boss', name, title, kills, seen, lore}[]}
   *   in data order (enemies, then bosses)
   */
  getBestiary() {
    const rows = [];
    for (const e of this._enemies) {
      rows.push(this._row('enemy', e.id, e.name, e.title ?? null, e.lore ?? ''));
    }
    for (const b of this._bosses) {
      rows.push(this._row('boss', b.id, b.name, b.title ?? null, b.lore ?? ''));
    }
    return rows;
  }

  /** @param {string} id enemy or boss id @returns {object|null} */
  getEntry(id) {
    return this.getBestiary().find((r) => r.id === id) ?? null;
  }

  /** @param {string} id @returns {number} */
  getKillCount(id) {
    return this.state.data.bestiary[id]?.kills ?? 0;
  }

  /** @returns {number} total recorded kills across the bestiary */
  getTotalKills() {
    return Object.values(this.state.data.bestiary).reduce((n, e) => n + (e.kills ?? 0), 0);
  }

  /** @private */
  _row(kind, id, name, title, lore) {
    const data = this.state.data.bestiary[id] ?? { seen: false, kills: 0 };
    return { id, kind, name, title, kills: data.kills ?? 0, seen: !!data.seen, lore };
  }
}

/** Shared singleton (GameScene / UI use this instance). */
export const bestiary = new Bestiary();
