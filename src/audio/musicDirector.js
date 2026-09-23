/**
 * src/audio/musicDirector.js — event-driven music transitions (Wave 5 audio).
 *
 * Phaser-free module (like src/scenes/gameEntry.js) so the transition logic
 * is unit-testable in node. The director subscribes to EventBus catalog
 * events and calls audioManager.playMusic — the ONLY audio path
 * (ARCHITECTURE.md §6; docs/AUDIO.md). Boss.js no longer touches music
 * directly; the director switches on `boss:encounterStarted` and restores
 * the region theme on `boss:died` / `player:died`.
 *
 * Region music on ordinary room changes stays with RoomManager (W3-ROOMS
 * contract); this module only handles the boss-fight overrides.
 */
import { trackForRegion } from './index.js';

/**
 * Boss def -> boss theme id (data/bosses.json `music` field). Pure.
 * @param {object|null|undefined} bossDef
 * @returns {string|null}
 */
export function bossMusicFor(bossDef) {
  const m = bossDef?.music;
  return typeof m === 'string' && m.length > 0 ? m : null;
}

/**
 * Room def -> music id: the room's `music` tag wins (both arena rooms carry
 * their boss theme as the room tag), falling back to the region theme.
 * Pure.
 * @param {object|null|undefined} roomDef
 * @returns {string|null}
 */
export function roomMusicFor(roomDef) {
  if (!roomDef || typeof roomDef !== 'object') return null;
  if (typeof roomDef.music === 'string' && roomDef.music.length > 0) {
    return roomDef.music;
  }
  return trackForRegion(roomDef.region);
}

/**
 * Room def -> REGION theme only (ignores the room `music` tag). Used when a
 * boss fight ends: the arena rooms tag the boss theme, but after the kill
 * the region music resumes. Pure.
 * @param {object|null|undefined} roomDef
 * @returns {string|null}
 */
export function regionMusicForRoom(roomDef) {
  if (!roomDef || typeof roomDef !== 'object') return null;
  return trackForRegion(roomDef.region);
}

export class MusicDirector {
  /**
   * @param {object} [deps]
   * @param {object} [deps.bus] EventBus-like { on(event, fn) } (unsub optional)
   * @param {object} [deps.audio] AudioManager-like { playMusic(trackId) }
   * @param {Function} [deps.getRoomDef] (roomId) => room def | null
   * @param {Function} [deps.getBossDef] (bossId) => boss def | null
   */
  constructor({ bus = null, audio = null, getRoomDef = null, getBossDef = null } = {}) {
    this._bus = bus;
    this._audio = audio;
    this._getRoomDef = getRoomDef ?? (() => null);
    this._getBossDef = getBossDef ?? (() => null);
    /** @type {string|null} last room seen on room:changed (restore target) */
    this._roomId = null;
    /** @type {Array<Function>} */
    this._unsubs = [];
  }

  /**
   * Subscribe to the bus. Returns an unwire function.
   * @returns {Function}
   */
  wire() {
    if (!this._bus || typeof this._bus.on !== 'function') return () => {};
    const on = (ev, fn) => {
      try {
        const off = this._bus.on(ev, fn);
        if (typeof off === 'function') this._unsubs.push(off);
      } catch {
        /* bus is best-effort */
      }
    };
    on('room:changed', ({ to } = {}) => {
      this._roomId = to ?? null;
    });
    // Aggro: the boss's own theme (data/bosses.json `music`).
    on('boss:encounterStarted', ({ bossId } = {}) => {
      const track = bossMusicFor(this._safeGetBoss(bossId));
      if (track) this._play(track);
    });
    // Fight over: back to the REGION theme. The arena rooms tag the boss
    // theme as their room music, so roomMusicFor() would keep it playing —
    // the contract is region music after the kill.
    on('boss:died', ({ roomId } = {}) => {
      const track = regionMusicForRoom(this._safeGetRoom(roomId ?? this._roomId));
      if (track) this._play(track);
    });
    // Player death: restore the current room's region music (no-op when the
    // boss theme was never playing).
    on('player:died', () => {
      const track = regionMusicForRoom(this._safeGetRoom(this._roomId));
      if (track) this._play(track);
    });
    return () => this.unwire();
  }

  /** Detach all subscriptions. */
  unwire() {
    for (const off of this._unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this._unsubs = [];
  }

  /** @private */
  _play(trackId) {
    try {
      this._audio?.playMusic?.(trackId);
    } catch {
      /* audio is best-effort */
    }
  }

  /** @private */
  _safeGetRoom(id) {
    try {
      return id ? this._getRoomDef(id) : null;
    } catch {
      return null;
    }
  }

  /** @private */
  _safeGetBoss(id) {
    try {
      return id ? this._getBossDef(id) : null;
    } catch {
      return null;
    }
  }
}
