/**
 * gameEntry — Phaser-free GameScene helpers (docs/ARCHITECTURE.md §14, §15).
 *
 * Extracted so the entry-intent, pause ref-count, and region-ambience logic
 * is unit-testable in node (vitest runs with environment 'node'; Phaser
 * cannot be imported there). GameScene.js consumes these; it adds no
 * gameplay logic of its own.
 */

/** Room id every new game starts in (matches createInitialState). */
export const START_ROOM_ID = 'moonlit_gate_001';

/** Spawn used when no valid saved position exists. */
export const DEFAULT_SPAWN = Object.freeze({
  roomId: START_ROOM_ID,
  x: 64,
  y: 200,
});

/**
 * Region -> ambience bed id (AudioManager.setAmbience). GameScene applies
 * this on room:changed; RoomManager (W3-ROOMS contract) owns region MUSIC.
 * Unknown regions resolve to null (leave the current bed playing).
 */
export const REGION_AMBIENCE = Object.freeze({
  moonlit_gate: 'wind_night',
  hollow_keep: 'dungeon_drone',
});

/**
 * @param {string|null|undefined} region
 * @returns {string|null} ambience bed id, or null when the region is unknown
 */
export function resolveAmbienceForRegion(region) {
  if (typeof region !== 'string') return null;
  return REGION_AMBIENCE[region] ?? null;
}

/**
 * Room -> ambience bed id (AudioManager.setAmbience). The room def's
 * `ambience` tag wins when present (e.g. moonlit_gate_014 sits in the gate
 * region but drones like the keep), falling back to the region map.
 * Unknown rooms/regions resolve to null (leave the current bed playing).
 * Pure — GameScene applies this on room:changed.
 * @param {object|null|undefined} roomDef
 * @returns {string|null} ambience bed id, or null when nothing resolves
 */
export function resolveRoomAmbience(roomDef) {
  if (roomDef && typeof roomDef.ambience === 'string' && roomDef.ambience.length > 0) {
    return roomDef.ambience;
  }
  return resolveAmbienceForRegion(roomDef?.region);
}

/**
 * Resolve the entry intent from the data TitleScene passed to scene.start().
 *
 * TitleScene (Wave 1) pre-hydrates gameState itself (reset() for new game,
 * hydrate(save) for continue/load) and passes NO data — that is the
 * 'trust-state' mode and the normal path. An explicit { newGame } / { slot }
 * payload is also honored defensively so a future TitleScene (or a debug
 * command) can drive entry directly.
 *
 * @param {object|null|undefined} sceneData this.scene.settings.data
 * @returns {{ mode: 'new' } | { mode: 'load-slot', slot: number } | { mode: 'trust-state' }}
 */
export function resolveEntryIntent(sceneData) {
  if (sceneData && sceneData.newGame === true) return { mode: 'new' };
  if (sceneData && Number.isInteger(sceneData.slot)) {
    return { mode: 'load-slot', slot: sceneData.slot };
  }
  return { mode: 'trust-state' };
}

/**
 * Sanitize a saved player position into a spawn point. Falls back to
 * DEFAULT_SPAWN field-by-field so a corrupt/partial position can never
 * strand the player off-map.
 * @param {{ roomId?: unknown, x?: unknown, y?: unknown }|null|undefined} position
 * @returns {{ roomId: string, x: number, y: number }}
 */
export function resolveSpawn(position) {
  const roomId =
    position && typeof position.roomId === 'string' && position.roomId.length > 0
      ? position.roomId
      : DEFAULT_SPAWN.roomId;
  const x =
    position && Number.isFinite(position.x) ? position.x : DEFAULT_SPAWN.x;
  const y =
    position && Number.isFinite(position.y) ? position.y : DEFAULT_SPAWN.y;
  return { roomId, x, y };
}

/**
 * Derive the room id a special-room modal (SaveSanctum / TeleportChamber,
 * W3-ABILITIES) is bound to. The modals store the Room instance, which
 * exposes `.roomId` (the def id), NOT `.id` — and their raw `roomId`/`from`
 * fields end up holding the Room object when `.id` is undefined, so probe
 * the instance first and fall back to the raw field.
 * @param {object|null|undefined} mod modal instance
 * @returns {string|undefined}
 */
export function modalRoomId(mod) {
  const room = mod?.room;
  return room?.roomId ?? room?.id ?? room?.def?.id ?? mod?.roomId ?? mod?.from;
}

/**
 * PauseCoordinator — ARCHITECTURE §14 pause ref-count, Phaser-free.
 *
 * Opening a full screen pauses GameScene; closing resumes ONLY when no
 * other screen is open. Tab-hide auto-pause is an independent latch that
 * never fights the UI ref-count: gameplay runs only when BOTH are clear.
 */
export class PauseCoordinator {
  constructor() {
    /** @type {number} open full-screen UI overlays */
    this.uiCount = 0;
    /** @type {boolean} latched by game:autoPause, cleared by game:resumed */
    this.autoPaused = false;
    /** @type {Set<string>} which screens hold the pause (debug aid) */
    this.openScreens = new Set();
  }

  /** A full screen opened (ui:opened). Idempotent per screen id. */
  uiOpened(screen) {
    if (screen != null) {
      if (this.openScreens.has(screen)) return this.isPaused();
      this.openScreens.add(screen);
    }
    this.uiCount += 1;
    return this.isPaused();
  }

  /** A full screen closed (ui:closed). Never drives the count negative. */
  uiClosed(screen) {
    if (screen != null) {
      if (!this.openScreens.delete(screen)) return this.isPaused();
      this.uiCount = Math.max(0, this.uiCount - 1);
      return this.isPaused();
    }
    this.uiCount = Math.max(0, this.uiCount - 1);
    return this.isPaused();
  }

  /** @param {boolean} paused */
  setAutoPaused(paused) {
    this.autoPaused = !!paused;
    return this.isPaused();
  }

  /** @returns {boolean} true while any pause source is active */
  isPaused() {
    return this.uiCount > 0 || this.autoPaused;
  }
}
