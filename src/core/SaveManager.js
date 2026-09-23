/**
 * SaveManager — IndexedDB persistence (docs/SAVE_SYSTEM.md, spec §30/§31/§32).
 *
 * CONTRACT:
 * - Primary store is IndexedDB database `vesper-saves` v1, NOT localStorage.
 *   localStorage holds only the non-critical "last used slot" hint.
 * - Object stores: `saves` (keyPath 'slot', slots 1..3), `settings`
 *   (keyPath 'key', values `{ key, value }`).
 * - Save object = GameState.toJSON() + { schemaVersion, slot, savedAt }.
 * - `migrate(save)` is PURE: takes a save object, returns an upgraded clone
 *   at the current schema version. Wave agents adding fields MUST add a
 *   migration step (documented in CHANGELOG.md).
 * - Export format: { format:'vesper-save', game:'citadel-of-vesper',
 *   version, exportedAt, payload } → downloadable JSON; import validates
 *   format/game/version before writing to a slot.
 * - `write()` resolves { ok, error? } — gameplay never breaks on save failure.
 *
 * NOTE on dependency rules: core/ modules import only ./EventBus.js, so this
 * file cannot import SAVE_SCHEMA_VERSION from GameState.js. CURRENT_SCHEMA_VERSION
 * below MUST track it (both are 2; bump together with a migration step).
 */
import { eventBus } from './EventBus.js';

export const DB_NAME = 'vesper-saves';
export const DB_VERSION = 1;
export const SAVE_SLOTS = Object.freeze([1, 2, 3]);

/** Must match SAVE_SCHEMA_VERSION in GameState.js (kept local per core import rules). */
const CURRENT_SCHEMA_VERSION = 3;

const EXPORT_FORMAT = 'vesper-save';
const EXPORT_GAME = 'citadel-of-vesper';
const LAST_SLOT_KEY = 'vesper:lastSlot';

export class SaveManager {
  constructor() {
    /** @type {IDBDatabase|null} */
    this.db = null;
    /** @type {Promise<void>|null} in-flight open() to avoid double-opens */
    this._opening = null;
    /** @type {boolean} false when IndexedDB is unavailable (non-browser env) */
    this._available = typeof indexedDB !== 'undefined';
  }

  /** Open (or create) the database. Idempotent; safe to call before read/write. */
  async open() {
    if (this.db) return;
    if (!this._available) return;
    if (!this._opening) {
      this._opening = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('saves')) {
            db.createObjectStore('saves', { keyPath: 'slot' });
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => {
          this.db = req.result;
          resolve();
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
      }).finally(() => {
        this._opening = null;
      });
    }
    return this._opening;
  }

  /** @private run a transaction, resolving with the request result */
  _tx(storeName, mode, op) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(storeName, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(storeName);
      let request;
      try {
        request = op(store);
      } catch (err) {
        reject(err);
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** @private ensure the DB is open; returns false when unavailable */
  async _ready() {
    if (!this._available) return false;
    try {
      await this.open();
    } catch {
      return false;
    }
    return !!this.db;
  }

  /**
   * Write a save payload to a slot. Never throws into gameplay.
   * @param {number} slot 1..3
   * @param {object} saveObject GameState.toJSON() payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async write(slot, saveObject) {
    if (!SAVE_SLOTS.includes(slot)) return { ok: false, error: `invalid slot ${slot}` };
    if (!(await this._ready())) return { ok: false, error: 'indexeddb-unavailable' };
    const record = {
      ...structuredClone(saveObject),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      slot,
      savedAt: Date.now(),
    };
    try {
      await this._tx('saves', 'readwrite', (s) => s.put(record));
    } catch (err) {
      return { ok: false, error: `write failed: ${err?.message ?? err}` };
    }
    this.setLastSlot(slot);
    eventBus.emit('game:saved', { slot, playTime: record.playTime ?? 0 });
    return { ok: true };
  }

  /**
   * Read a slot. Runs migrate() so callers always get the current schema.
   * @param {number} slot 1..3
   * @returns {Promise<object|null>} migrated save object, or null when empty
   */
  async read(slot) {
    if (!SAVE_SLOTS.includes(slot)) return null;
    if (!(await this._ready())) return null;
    let record;
    try {
      record = await this._tx('saves', 'readonly', (s) => s.get(slot));
    } catch {
      return null;
    }
    if (!record) return null;
    try {
      return this.migrate(record);
    } catch {
      return null; // corrupt record: never crash the caller (slotInfo flags it)
    }
  }

  /**
   * @param {number} slot
   * @returns {Promise<{exists: boolean, corrupt?: boolean, savedAt?: number, playTime?: number, level?: number, playerName?: string}>}
   */
  async slotInfo(slot) {
    if (!SAVE_SLOTS.includes(slot)) return { exists: false };
    if (!(await this._ready())) return { exists: false };
    let record;
    try {
      record = await this._tx('saves', 'readonly', (s) => s.get(slot));
    } catch {
      return { exists: false };
    }
    if (!record) return { exists: false };
    const corrupt = typeof record !== 'object' || !record.player || !record.schemaVersion;
    if (corrupt) return { exists: true, corrupt: true };
    return {
      exists: true,
      savedAt: record.savedAt,
      playTime: record.playTime,
      level: record.player?.level,
      playerName: record.player?.name,
    };
  }

  /** @returns {Promise<Array<{slot:number,exists:boolean,corrupt?:boolean,savedAt?:number,playTime?:number,level?:number,playerName?:string}>>} */
  async listSlots() {
    return Promise.all(SAVE_SLOTS.map((slot) => this.slotInfo(slot).then((info) => ({ slot, ...info }))));
  }

  /** @param {number} slot @returns {Promise<void>} never throws */
  async deleteSlot(slot) {
    if (!SAVE_SLOTS.includes(slot)) return;
    if (!(await this._ready())) return;
    try {
      await this._tx('saves', 'readwrite', (s) => s.delete(slot));
    } catch {
      /* best effort; UI already confirmed */
    }
  }

  /** @param {string} key @param {*} value @returns {Promise<void>} never throws */
  async writeSetting(key, value) {
    if (!(await this._ready())) return;
    try {
      await this._tx('settings', 'readwrite', (s) => s.put({ key, value }));
    } catch {
      /* non-critical */
    }
  }

  /** @param {string} key @param {*} fallback @returns {Promise<*>} */
  async readSetting(key, fallback) {
    if (!(await this._ready())) return fallback;
    try {
      const rec = await this._tx('settings', 'readonly', (s) => s.get(key));
      return rec ? rec.value : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Pure migration: upgrade any older save to the current schema version.
   * Wave agents adding fields MUST add a step here (and bump
   * CURRENT_SCHEMA_VERSION + GameState.SAVE_SCHEMA_VERSION together).
   * @param {object} save raw stored save object
   * @returns {object} upgraded clone at CURRENT_SCHEMA_VERSION
   */
  migrate(save) {
    const out = structuredClone(save);
    const from = out.schemaVersion ?? 0;

    // v0 -> v1: backfill every section a v1 save is expected to carry.
    if (from < 1) {
      out.meta ??= {};
      out.player ??= {};
      out.player.stats ??= {};
      out.player.position ??= { roomId: 'moonlit_gate_001', x: 64, y: 200 };
      out.player.abilities ??= [];
      out.player.spells ??= [];
      out.inventory ??= [];
      out.equipment ??= {
        weapon: null, offhand: null, head: null, body: null,
        accessory1: null, accessory2: null,
      };
      out.currency ??= 0;
      out.map ??= { discovered: [], completion: 0 };
      out.flags ??= {};
      out.bossStates ??= {};
      out.chestStates ??= {};
      out.checkpoints ??= {};
      out.teleports ??= [];
      out.quests ??= {};
      out.bestiary ??= {};
      out.settings ??= {};
      out.playTime ??= 0;
      out.difficulty ??= 'normal';
    }

    // v1 -> v2: merchant finite-stock tracking + timed buffs.
    if (from < 2) {
      out.merchantStock ??= {};
      out.buffs ??= [];
    }

    // v2 -> v3: quick-use consumable preference.
    if (from < 3) {
      out.settings = out.settings && typeof out.settings === 'object' ? out.settings : {};
      if (typeof out.settings.quickUseItemId !== 'string') {
        out.settings.quickUseItemId = 'ember_tonic';
      }
    }

    out.schemaVersion = CURRENT_SCHEMA_VERSION;
    return out;
  }

  // ------------------------------------------------------- export / import

  /**
   * Build the export envelope for a slot (pure data; caller triggers download).
   * @param {number} slot
   * @returns {Promise<{ok: boolean, error?: string, filename?: string, export?: object}>}
   */
  async exportSave(slot) {
    const save = await this.read(slot);
    if (!save) return { ok: false, error: 'slot is empty' };
    const date = new Date().toISOString().slice(0, 10);
    return {
      ok: true,
      filename: `vesper-save-slot${slot}-${date}.json`,
      export: {
        format: EXPORT_FORMAT,
        game: EXPORT_GAME,
        version: CURRENT_SCHEMA_VERSION,
        exportedAt: Date.now(),
        payload: save,
      },
    };
  }

  /**
   * Trigger a browser download of an export envelope.
   * @param {{filename: string, export: object}} built by exportSave()
   */
  downloadExport({ filename, export: envelope }) {
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /**
   * Validate an export envelope (parsed JSON or raw string) and write it to
   * a slot. Rejects wrong format/game, and versions newer than supported.
   * @param {string|object} fileData parsed JSON or raw file text
   * @param {number} slot 1..3
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async importSave(fileData, slot) {
    if (!SAVE_SLOTS.includes(slot)) return { ok: false, error: `invalid slot ${slot}` };
    let envelope;
    try {
      envelope = typeof fileData === 'string' ? JSON.parse(fileData) : fileData;
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
    if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'not a save file' };
    if (envelope.format !== EXPORT_FORMAT) return { ok: false, error: `bad format '${envelope.format}' (expected '${EXPORT_FORMAT}')` };
    if (envelope.game !== EXPORT_GAME) return { ok: false, error: `wrong game '${envelope.game}'` };
    if (typeof envelope.version !== 'number') return { ok: false, error: 'missing version' };
    if (envelope.version > CURRENT_SCHEMA_VERSION) {
      return { ok: false, error: `save is schema v${envelope.version}; this build supports v${CURRENT_SCHEMA_VERSION}` };
    }
    if (!envelope.payload || typeof envelope.payload !== 'object') {
      return { ok: false, error: 'missing save payload' };
    }
    const migrated = this.migrate({ ...envelope.payload, schemaVersion: envelope.version });
    return this.write(slot, migrated);
  }

  // ---------------------------------------------------------- last-slot hint

  /** Non-critical localStorage hint only (per SAVE_SYSTEM.md). */
  getLastSlot() {
    try {
      const v = Number(localStorage.getItem(LAST_SLOT_KEY));
      return SAVE_SLOTS.includes(v) ? v : 1;
    } catch {
      return 1;
    }
  }

  /** @param {number} slot */
  setLastSlot(slot) {
    try {
      localStorage.setItem(LAST_SLOT_KEY, String(slot));
    } catch {
      /* non-critical */
    }
  }
}

/** Shared singleton. */
export const saveManager = new SaveManager();
