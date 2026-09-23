/**
 * GameState — the single source of truth for all mutable game data.
 *
 * CONTRACT (see docs/ARCHITECTURE.md §3, docs/SAVE_SYSTEM.md):
 * - One instance per game session (singleton `gameState`). New Game resets it
 *   via `reset()`; Continue hydrates it via SaveManager.
 * - Plain serializable data ONLY: no Phaser objects, no class instances, no
 *   functions. `toJSON()` output is exactly what gets written to IndexedDB.
 * - Every mutation goes through a documented method which sets `dirty = true`
 *   and emits the matching event from the `Events` catalog (no per-frame
 *   emissions; state transitions only).
 * - Derived stats are COMPUTED by PlayerStats (Wave 2) — never stored here.
 *
 * Sections: meta · player · inventory · equipment · currency · map · flags ·
 * bossStates · chestStates · checkpoints · teleports · quests · bestiary ·
 * merchantStock · buffs · settings.
 */
import { eventBus } from './EventBus.js';

export const SAVE_SCHEMA_VERSION = 3;

const EQUIPMENT_SLOTS = Object.freeze([
  'weapon', 'offhand', 'head', 'body', 'accessory1', 'accessory2',
]);

/** @returns {object} a fresh new-game state (Lucien Vale, Moonlit Gate start). */
export function createInitialState() {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    // --- meta ---
    playTime: 0, // seconds, accumulated by GameScene.update
    createdAt: Date.now(),
    difficulty: 'normal',
    // --- player ---
    player: {
      name: 'Lucien Vale',
      level: 1,
      xp: 0,
      hp: 60,
      maxHp: 60,
      mp: 20,
      maxMp: 20,
      stats: {
        strength: 8,
        constitution: 8,
        dexterity: 8,
        intelligence: 8,
        luck: 8,
      },
      // Derived stats are COMPUTED (src/player/PlayerStats.js), never stored.
      position: { roomId: 'moonlit_gate_001', x: 64, y: 200 },
      abilities: [], // traversal unlocks, e.g. ['moonrise_leap']
      spells: [], // learned magic, e.g. ['cinder_wave']
    },
    // --- inventory & equipment ---
    inventory: [], // [{ itemId, quantity }]
    equipment: {
      weapon: null, // itemId or null
      offhand: null,
      head: null,
      body: null,
      accessory1: null,
      accessory2: null,
    },
    currency: 0, // vesper coins
    // --- world ---
    map: {
      discovered: [], // roomIds
      completion: 0, // percent; computed by src/map/MapModel.js
    },
    flags: {}, // arbitrary string->any story/world flags, e.g. { met_merchant: true }
    bossStates: {}, // bossId -> 'locked'|'unlocked'|'defeated'
    chestStates: {}, // chestId -> true (opened)
    checkpoints: {}, // checkpointId -> { roomId, x, y }
    teleports: [], // discovered chamber ids
    quests: {}, // questId -> { stage, ... }
    bestiary: {}, // enemyId -> { seen: true, kills: 0 }
    merchantStock: {}, // merchantId -> { itemId -> remaining units } (finite stock only)
    buffs: [], // active timed buffs: [{ id, name, stats:{}, expiresAt }] (expiresAt = playTime seconds)
    // --- settings (also persisted via SaveManager settings store) ---
    settings: {
      musicVolume: 0.8,
      sfxVolume: 0.8,
      ambienceVolume: 0.8,
      screenShake: true,
      damageNumbers: true,
      language: 'en',
      quickUseItemId: 'ember_tonic', // consumable used by the quick-use key/button
    },
  };
}

class GameState {
  constructor() {
    /** @type {object} the serializable state tree */
    this.data = createInitialState();
    /** @type {boolean} true when data changed since the last save */
    this.dirty = false;
  }

  // ------------------------------------------------------------------ base

  /** Reset to a fresh new-game state. Emits nothing (Boot/Title handles UI). */
  reset() {
    this.data = createInitialState();
    this.dirty = true;
  }

  /**
   * Replace state wholesale (used by SaveManager on load; data must already
   * be migrated to SAVE_SCHEMA_VERSION).
   * @param {object} saveObject migrated save payload
   */
  hydrate(saveObject) {
    this.data = structuredClone(saveObject);
    this.dirty = false;
  }

  /** @returns {object} deep-cloned save payload for SaveManager.write(). */
  toJSON() {
    return structuredClone(this.data);
  }

  // ------------------------------------------------------------------ flags

  /** @param {string} flag @param {*} value */
  setFlag(flag, value) {
    this.data.flags[flag] = value;
    this.dirty = true;
    eventBus.emit('flag:set', { flag, value });
  }

  /** @param {string} flag @returns {*} */
  getFlag(flag) {
    return this.data.flags[flag];
  }

  // -------------------------------------------------------------- inventory

  /** @param {string} itemId @param {number} [quantity=1] */
  addItem(itemId, quantity = 1) {
    const entry = this.data.inventory.find((i) => i.itemId === itemId);
    if (entry) entry.quantity += quantity;
    else this.data.inventory.push({ itemId, quantity });
    this.dirty = true;
    eventBus.emit('item:pickedUp', { itemId, quantity });
    eventBus.emit('inventory:changed', {});
  }

  /**
   * @param {string} itemId @param {number} [quantity=1]
   * @returns {boolean} false when the item is not held
   */
  removeItem(itemId, quantity = 1) {
    const idx = this.data.inventory.findIndex((i) => i.itemId === itemId);
    if (idx === -1) return false;
    const entry = this.data.inventory[idx];
    entry.quantity -= quantity;
    if (entry.quantity <= 0) this.data.inventory.splice(idx, 1);
    this.dirty = true;
    eventBus.emit('inventory:changed', {});
    return true;
  }

  /** @param {string} itemId @returns {number} */
  countItem(itemId) {
    return this.data.inventory.find((i) => i.itemId === itemId)?.quantity ?? 0;
  }

  // -------------------------------------------------------------- equipment

  /**
   * Equip an item into a fixed slot. Emits `item:equipped`; PlayerStats.recalc()
   * listens downstream (Wave 2). Callers validate the item via ItemData.
   * @param {string} slot one of EQUIPMENT_SLOTS
   * @param {string} itemId
   */
  equip(slot, itemId) {
    if (!EQUIPMENT_SLOTS.includes(slot)) throw new Error(`unknown equipment slot '${slot}'`);
    this.data.equipment[slot] = itemId;
    this.dirty = true;
    eventBus.emit('item:equipped', { itemId, slot });
    eventBus.emit('inventory:changed', {});
  }

  /** @param {string} slot one of EQUIPMENT_SLOTS */
  unequip(slot) {
    if (!EQUIPMENT_SLOTS.includes(slot)) throw new Error(`unknown equipment slot '${slot}'`);
    this.data.equipment[slot] = null;
    this.dirty = true;
    eventBus.emit('item:unequipped', { slot });
    eventBus.emit('inventory:changed', {});
  }

  // ------------------------------------------------------------------ player

  /**
   * Add raw XP. Level-up resolution belongs to PlayerStats (Wave 2), which
   * listens for `player:xpGained`.
   * @param {number} amount
   */
  addXp(amount) {
    this.data.player.xp += amount;
    this.dirty = true;
    eventBus.emit('player:xpGained', { amount, total: this.data.player.xp });
  }

  /** @param {string} abilityId traversal or spell id (idempotent) */
  unlockAbility(abilityId) {
    if (!this.data.player.abilities.includes(abilityId)) {
      this.data.player.abilities.push(abilityId);
      this.dirty = true;
      eventBus.emit('player:abilityUnlocked', { abilityId });
    }
  }

  /** @param {string} spellId learned-spell id (idempotent) */
  learnSpell(spellId) {
    if (!this.data.player.spells.includes(spellId)) {
      this.data.player.spells.push(spellId);
      this.dirty = true;
      eventBus.emit('player:abilityUnlocked', { abilityId: spellId });
    }
  }

  /** @param {number} hp clamped to [0, maxHp] */
  setHp(hp) {
    this.data.player.hp = Math.max(0, Math.min(this.data.player.maxHp, hp));
    this.dirty = true;
  }

  /** @param {number} mp clamped to [0, maxMp] */
  setMp(mp) {
    this.data.player.mp = Math.max(0, Math.min(this.data.player.maxMp, mp));
    this.dirty = true;
  }

  /** Restore HP/MP to full (rest sequence / debug). Emits `player:healed`. */
  rest() {
    const amount = this.data.player.maxHp - this.data.player.hp;
    this.data.player.hp = this.data.player.maxHp;
    this.data.player.mp = this.data.player.maxMp;
    this.dirty = true;
    eventBus.emit('player:healed', {
      amount,
      hp: this.data.player.hp,
      maxHp: this.data.player.maxHp,
    });
  }

  /** @param {string} roomId @param {number} x @param {number} y */
  setPosition(roomId, x, y) {
    this.data.player.position = { roomId, x, y };
    this.dirty = true;
  }

  // ---------------------------------------------------------------- currency

  /** @param {number} amount (negative amounts are ignored) */
  addCurrency(amount) {
    if (amount <= 0) return;
    this.data.currency += amount;
    this.dirty = true;
    eventBus.emit('inventory:changed', {});
  }

  /**
   * @param {number} amount
   * @returns {boolean} false when funds are insufficient (no change)
   */
  spendCurrency(amount) {
    if (amount <= 0) return true;
    if (this.data.currency < amount) return false;
    this.data.currency -= amount;
    this.dirty = true;
    eventBus.emit('inventory:changed', {});
    return true;
  }

  // -------------------------------------------------------------------- map

  /**
   * Record a room discovery (idempotent). `completion` is maintained by
   * MapModel (Wave 3); this emits the catalog event with the current value.
   * @param {string} roomId @param {string} region
   */
  discoverRoom(roomId, region) {
    if (!this.data.map.discovered.includes(roomId)) {
      this.data.map.discovered.push(roomId);
      this.dirty = true;
      eventBus.emit('map:roomDiscovered', {
        roomId,
        region,
        completion: this.data.map.completion,
      });
    }
  }

  /** @param {number} percent 0..100, set by MapModel (Wave 3) */
  setMapCompletion(percent) {
    this.data.map.completion = Math.max(0, Math.min(100, percent));
    this.dirty = true;
  }

  // ------------------------------------------------------------------ bosses

  /** @param {string} bossId @param {'locked'|'unlocked'|'defeated'} state */
  setBossState(bossId, state) {
    this.data.bossStates[bossId] = state;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ chests

  /** @param {string} chestId @param {boolean} [opened=true] */
  setChestState(chestId, opened = true) {
    this.data.chestStates[chestId] = opened;
    this.dirty = true;
  }

  // ------------------------------------------------------------- checkpoints

  /**
   * Record a touched checkpoint (respawn anchor).
   * @param {string} checkpointId @param {string} roomId @param {number} x @param {number} y
   */
  setCheckpoint(checkpointId, roomId, x, y) {
    this.data.checkpoints[checkpointId] = { roomId, x, y };
    this.dirty = true;
    eventBus.emit('room:checkpointTouched', { roomId, checkpointId });
  }

  // --------------------------------------------------------------- teleports

  /** @param {string} chamberId (idempotent) */
  discoverTeleport(chamberId) {
    if (!this.data.teleports.includes(chamberId)) {
      this.data.teleports.push(chamberId);
      this.dirty = true;
      eventBus.emit('teleport:discovered', { chamberId });
    }
  }

  /** @param {string} from chamberId @param {string} to chamberId */
  useTeleport(from, to) {
    this.dirty = true;
    eventBus.emit('teleport:used', { from, to });
  }

  // ------------------------------------------------------------------ quests

  /**
   * @param {string} questId @param {string} stage
   * @param {object} [extra] additional quest data merged into the entry
   */
  setQuestStage(questId, stage, extra = {}) {
    this.data.quests[questId] = { ...(this.data.quests[questId] ?? {}), stage, ...extra };
    this.dirty = true;
    eventBus.emit('quest:updated', { questId, stage });
  }

  // ---------------------------------------------------------------- bestiary

  /** @param {string} enemyId */
  markBestiarySeen(enemyId) {
    const entry = this.data.bestiary[enemyId] ?? { seen: false, kills: 0 };
    entry.seen = true;
    this.data.bestiary[enemyId] = entry;
    this.dirty = true;
  }

  /** @param {string} enemyId */
  recordBestiaryKill(enemyId) {
    const entry = this.data.bestiary[enemyId] ?? { seen: true, kills: 0 };
    entry.seen = true;
    entry.kills += 1;
    this.data.bestiary[enemyId] = entry;
    this.dirty = true;
  }

  // ---------------------------------------------------------- merchant stock

  /**
   * Remaining units of a finite-stock merchant line. `null` = not tracked
   * (unlimited goods or untouched finite line — callers fall back to the
   * data quantity).
   * @param {string} merchantId @param {string} itemId @returns {number|null}
   */
  getMerchantStock(merchantId, itemId) {
    return this.data.merchantStock[merchantId]?.[itemId] ?? null;
  }

  /** @param {string} merchantId @param {string} itemId @param {number} qty */
  setMerchantStock(merchantId, itemId, qty) {
    const m = (this.data.merchantStock[merchantId] ??= {});
    m[itemId] = Math.max(0, qty);
    this.dirty = true;
    eventBus.emit('inventory:changed', {});
  }

  // ------------------------------------------------------------------ buffs

  /**
   * Add (or refresh) a timed buff. `expiresAt` is in playTime seconds; buffs
   * pause with the game because playTime only advances while unpaused.
   * @param {{id:string, name?:string, stats:object, expiresAt:number}} buff
   */
  addBuff(buff) {
    this.pruneBuffs(this.data.playTime);
    const idx = this.data.buffs.findIndex((b) => b.id === buff.id);
    const entry = {
      id: buff.id,
      name: buff.name ?? buff.id,
      stats: { ...buff.stats },
      expiresAt: buff.expiresAt,
    };
    if (idx === -1) this.data.buffs.push(entry);
    else this.data.buffs[idx] = entry;
    this.dirty = true;
    eventBus.emit('inventory:changed', {});
  }

  /**
   * Drop expired buffs (idempotent).
   * @param {number} [nowSec] defaults to current playTime
   * @returns {number} buffs removed
   */
  pruneBuffs(nowSec = this.data.playTime) {
    const before = this.data.buffs.length;
    this.data.buffs = this.data.buffs.filter((b) => b.expiresAt > nowSec);
    if (this.data.buffs.length !== before) {
      this.dirty = true;
      eventBus.emit('inventory:changed', {});
    }
    return before - this.data.buffs.length;
  }

  /**
   * Summed stat bonuses from currently-active buffs (read by
   * PlayerStats._equipmentBonuses — no new imports needed).
   * @param {number} [nowSec] defaults to current playTime
   * @returns {Record<string, number>}
   */
  getBuffStatBonuses(nowSec = this.data.playTime) {
    const bonus = {};
    for (const b of this.data.buffs) {
      if (b.expiresAt <= nowSec) continue;
      for (const [k, v] of Object.entries(b.stats ?? {})) {
        if (typeof v === 'number') bonus[k] = (bonus[k] ?? 0) + v;
      }
    }
    return bonus;
  }

  // -------------------------------------------------------------------- meta

  /** @param {number} seconds total play time */
  setPlayTime(seconds) {
    this.data.playTime = Math.max(0, Math.floor(seconds));
    this.dirty = true;
  }

  /** @param {Partial<object>} partial merged into settings */
  updateSettings(partial) {
    Object.assign(this.data.settings, partial);
    this.dirty = true;
  }
}

/** Shared singleton. */
export const gameState = new GameState();
