/**
 * RoomManager — loads, streams, and transitions rooms (spec §25, §26).
 *
 * CONTRACT:
 * - Rooms are data: data/rooms.json, validated against data/schemas/room.schema.json.
 * - Only the CURRENT room's entities are live (spec §10). Neighboring rooms
 *   contribute metadata (exits, preload hints) via AssetManager.preloadAdjacent().
 * - loadRoom(roomId, spawnHint): tears down the previous room (enemies,
 *   projectiles, particles, physics bodies), builds tilemap + entities for
 *   the new room, places the player at the matching exit spawn.
 * - ROOM TRANSITION PROTOCOL:
 *   1. Player crosses an exit trigger (or uses a door/teleport).
 *   2. RoomManager emits 'room:changed' AFTER the new room is live
 *      (payload { from, to, via }).
 *   3. Camera locks during the transition: brief fade/slide (<= 300ms),
 *      player keeps momentum direction, no input dead-zone longer than the
 *      transition itself. No full loading screens between normal rooms.
 *   4. Map discovery: gameState.discoverRoom(to) fires exactly once per
 *      newly discovered room.
 * - Exit coordinates: each exit defines the spawn point in the DESTINATION
 *   room (see data/schemas/room.schema.json `exits` entries).
 * - Save rooms (saveRoom: true) hand off to SaveSanctum via the
 *   `roomManager.onSaveRoom` hook (default no-op; W3-ABILITIES assigns it:
 *   `roomManager.onSaveRoom = (room) => sanctum.activate(room)`).
 * - Teleport chambers (teleport: true) register on first entry
 *   (`teleport:discovered` via gameState.discoverTeleport) and call the
 *   `roomManager.onTeleportRoom` hook (default no-op; GameScene assigns it:
 *   `roomManager.onTeleportRoom = (room) => chamber.bind(room)`).
 * - Gated exits: `requires` (abilities) / `requiresItem` (key item in
 *   inventory) / `secretId` (undiscovered secret). Unmet ability/item gates
 *   show a blocked shimmer + hint text instead of transitioning.
 *
 * Wave 3 implements.
 */
import { dataManager } from '../core/DataManager.js';
import { gameState } from '../core/GameState.js';
import { eventBus } from '../core/EventBus.js';
import { audioManager } from '../core/AudioManager.js';
import { assetManager, Stages } from '../core/AssetManager.js';
import { abilityManager } from '../abilities/index.js';
import { createEnemyAnims } from '../enemies/index.js';
import { Pickup } from '../props/Pickup.js';
import { trackForRegion } from '../audio/index.js';
import { Room, secretFlag } from './Room.js';

/** Player hurtbox box (matches GameScene's PLAYER_HURTBOX; idempotent). */
const PLAYER_HURTBOX = { w: 14, h: 22, offsetX: 0, offsetY: -11 };

/** Cooldown between blocked-exit shimmers for one exit (ms). */
const BLOCKED_COOLDOWN_MS = 1500;

/**
 * Pure: decide whether an exit may be used.
 * @param {object} exit exit definition from room data
 * @param {object} gates { hasAbility(id)->bool, hasItem(id)->bool }
 * @returns {{ok:boolean, blockedBy:'ability'|'item'|null, missing:string[], hint:string|null}}
 */
export function checkExitGate(exit, gates) {
  const missing = (exit.requires ?? []).filter((id) => !gates.hasAbility(id));
  if (missing.length > 0) {
    return {
      ok: false,
      blockedBy: 'ability',
      missing,
      hint: exit.hint ?? `Sealed. It requires ${missing.join(', ')}.`,
    };
  }
  if (exit.requiresItem && !gates.hasItem(exit.requiresItem)) {
    return {
      ok: false,
      blockedBy: 'item',
      missing: [exit.requiresItem],
      hint: exit.hint ?? 'Locked. A key item would open it.',
    };
  }
  return { ok: true, blockedBy: null, missing: [], hint: null };
}

/**
 * Pure: resolve where the player appears in a room.
 * @param {object} def room definition
 * @param {{x:number,y:number,facing?:number}|null} spawnHint from the exit used
 * @returns {{x:number,y:number,facing:number}}
 */
export function resolveSpawn(def, spawnHint) {
  if (spawnHint) {
    return { x: spawnHint.x, y: spawnHint.y, facing: spawnHint.facing ?? 1 };
  }
  if (def.playerStart) {
    return {
      x: def.playerStart.x,
      y: def.playerStart.y,
      facing: def.playerStart.facing ?? 1,
    };
  }
  return { x: 60, y: 200, facing: 1 };
}

export class RoomManager {
  /**
   * @param {Phaser.Scene} scene the persistent GameScene
   * @param {object} [deps] injectable singletons (tests): dataManager,
   *   gameState, eventBus, audioManager, assetManager, abilityManager
   */
  constructor(scene, deps = {}) {
    this.scene = scene;
    this._deps = {
      dataManager,
      gameState,
      eventBus,
      audioManager,
      assetManager,
      abilityManager,
      ...deps,
    };
    /** @type {string|null} */
    this.currentRoomId = null;
    /** @type {Room|null} */
    this.room = null;
    /** Save-room handoff (W3-ABILITIES): (room) => void. Default no-op. */
    this.onSaveRoom = null;
    /** Teleport-room handoff (GameScene TeleportChamber): (room) => void. */
    this.onTeleportRoom = null;

    this._hitboxSystem = null;
    this._projectileSystem = null;
    this._effectsManager = null;
    this._getPlayerFn = null;
    this._transitioning = false;
    /** exit id of the in-flight / last transition (the `via` of room:changed) */
    this._lastVia = 'spawn';
    this._lastTrack = null;
    // (W5-AUDIO: ambience is owned by GameScene; see loadRoom.)
    this._animsRegion = null;
    this._blockedAt = new Map(); // exit id -> timestamp of last shimmer
    /** W4-BOSS: exit lock reason string, or null when exits are open. */
    this.exitLock = null;
  }

  /**
   * Wire the combat/pooling systems created by GameScene (W3-GAME).
   * @param {object} systems { hitboxSystem, projectileSystem, effectsManager?,
   *   getPlayer? } — getPlayer overrides the default `scene.player` lookup.
   */
  init({ hitboxSystem, projectileSystem, effectsManager = null, getPlayer = null } = {}) {
    this._hitboxSystem = hitboxSystem ?? null;
    this._projectileSystem = projectileSystem ?? null;
    this._effectsManager = effectsManager ?? null;
    this._getPlayerFn = getPlayer ?? null;
    // AssetManager room-graph providers are wired by GameScene at boot;
    // RoomManager only consumes assetManager.preloadAdjacent().
  }

  /** @private the persistent player facade (created by GameScene) */
  _getPlayer() {
    if (this._getPlayerFn) return this._getPlayerFn();
    return this.scene?.player ?? null;
  }

  /** @private gate predicates backed by live singletons */
  _gates() {
    const { gameState: gs, abilityManager: am } = this._deps;
    return {
      hasAbility: (id) => {
        try {
          return am.has(id);
        } catch {
          return (gs.data.player.abilities ?? []).includes(id);
        }
      },
      hasItem: (id) =>
        (gs.data.inventory ?? []).some((e) => e.itemId === id && (e.quantity ?? 0) > 0),
    };
  }

  // ------------------------------------------------------------------ query

  /** @param {string} roomId @returns {object} raw room definition (cached) */
  getRoomDef(roomId) {
    const def = this._deps.dataManager.getRoom(roomId);
    if (!def) {
      throw new Error(
        `[RoomManager] unknown room id '${roomId}'. Check data/rooms.json.`,
      );
    }
    return def;
  }

  /** @returns {string[]} roomIds adjacent to currentRoomId */
  getAdjacentRoomIds() {
    if (!this.currentRoomId) return [];
    const def = this.getRoomDef(this.currentRoomId);
    return [...new Set((def.exits ?? []).map((e) => e.target))];
  }

  // ------------------------------------------------------------------- load

  /**
   * @param {string} roomId
   * @param {{x:number,y:number,facing?:number}|null} [spawnHint] explicit spawn;
   *   null = room playerStart (room 001) or the exit we arrived through
   * @returns {Promise<void>}
   */
  async loadRoom(roomId, spawnHint = null) {
    if (!this.scene) {
      throw new Error('[RoomManager] loadRoom() needs a scene — was init() called by GameScene?');
    }
    const { gameState: gs, eventBus: bus, audioManager: audio, assetManager: assets } = this._deps;
    const def = this.getRoomDef(roomId);
    const from = this.currentRoomId;
    const via = this._lastVia; // one-shot: reset so direct loads report 'spawn'
    this._lastVia = 'spawn';

    // The region art pack (tileset texture, parallax, enemy sheets) must be
    // resident BEFORE Room.build paints the tilemap: building with a missing
    // tileset falls back to invisible collision bodies, leaving the first
    // room of a region permanently black. loadStage is idempotent per pack.
    if (def?.region && assets && typeof assets.loadStage === 'function') {
      const packId = `room_${def.region}`;
      try {
        await assets.loadStage(this.scene, Stages.ROOM(def.region), [packId]);
      } catch (err) {
        console.warn(`[RoomManager] region pack '${packId}' failed:`, err?.message);
      }
    }

    this.unloadCurrentRoom();

    const room = new Room(this.scene, def);
    room.build({
      getPlayer: () => this._getPlayer(),
      hitboxSystem: this._hitboxSystem,
      projectileSystem: this._projectileSystem,
      effectsManager: this._effectsManager,
      onExit: (exit) => this.requestExit(exit),
      spawnPickup: (x, y, ref, opts = {}) => this.spawnPickup(x, y, ref, opts),
      onEnemyDeath: (enemy) => this._onEnemyDeath(enemy),
    });
    this.room = room;

    // Enemy anims once per region pack.
    try {
      if (this._animsRegion !== def.region) {
        createEnemyAnims(this.scene, this._deps.dataManager.getData('enemies'));
        this._animsRegion = def.region;
      }
    } catch { /* anims are cosmetic; never break room load */ }

    // Place the player (momentum preserved across transitions).
    const player = this._getPlayer();
    if (player) {
      const spawn = resolveSpawn(def, spawnHint);
      let vx = 0, vy = 0;
      try {
        const v = player.getMovement?.().getVelocity?.();
        if (v) { vx = v.x ?? 0; vy = v.y ?? 0; }
      } catch { /* momentum is best-effort */ }
      try {
        player.setPosition(spawn.x, spawn.y, spawn.facing);
        player.getSprite?.()?.body?.setVelocity?.(vx, vy);
      } catch { /* placement must not throw */ }
      // (Re)register the player hurtbox — idempotent by entity id.
      try {
        player.id = player.id ?? 'player';
        this._hitboxSystem?.registerHurtbox?.(player, { ...PLAYER_HURTBOX });
      } catch { /* GameScene already registers it */ }
    }

    // Camera bounds follow the room (follow target persists from GameScene).
    try {
      this.scene.cameras.main.setBounds(0, 0, def.width, def.height);
    } catch { /* headless / mocked scene */ }

    // Region music (skip when unchanged to avoid restarts). Ambience is
    // owned by GameScene on room:changed (W5-AUDIO): it resolves the room
    // def's `ambience` tag first, so RoomManager must NOT setAmbience here
    // or it would clobber per-room tags like moonlit_gate_014's drone.
    const trackId = def.music ?? trackForRegion(def.region) ?? null;
    if (trackId && trackId !== this._lastTrack) {
      try { audio.playMusic(trackId); } catch { /* audio optional */ }
      this._lastTrack = trackId;
    }

    // Discovery (idempotent inside GameState; event fires once).
    gs.discoverRoom(roomId, def.region);

    // Save / teleport handoffs.
    if (def.saveRoom) {
      try { this.onSaveRoom?.(room); } catch (err) {
        console.warn('[RoomManager] onSaveRoom threw:', err?.message);
      }
    }
    if (def.teleport) {
      const known = (gs.data.teleports ?? []).includes(roomId);
      if (!known) gs.discoverTeleport(roomId); // emits teleport:discovered
      try { this.onTeleportRoom?.(room); } catch (err) {
        console.warn('[RoomManager] onTeleportRoom threw:', err?.message);
      }
    }

    this.currentRoomId = roomId;
    bus.emit('room:changed', { from, to: roomId, via });

    // Warm neighbor region packs (non-blocking).
    try {
      assets.preloadAdjacent(this.scene, roomId);
    } catch { /* preload is best-effort */ }
  }

  /**
   * Player crossed an exit trigger. Gate-checked; blocked exits shimmer.
   * @param {object} exit exit definition from the current room's data
   * @returns {Promise<boolean>} true when a transition started
   */
  async requestExit(exit) {
    if (this._transitioning) return false;
    // W4-BOSS: boss fights seal the arena exits until the boss dies.
    if (this.exitLock) {
      this._showBlocked(exit, { hint: 'The way out is sealed.' });
      return false;
    }
    const check = checkExitGate(exit, this._gates());
    if (!check.ok) {
      this._showBlocked(exit, check);
      return false;
    }
    return this.transitionThrough(exit);
  }

  /**
   * Begin a transition through an exit. Handles camera lock + protocol above.
   * @param {object} exit exit definition from the current room's data
   * @returns {Promise<boolean>} true when the transition completed
   */
  async transitionThrough(exit) {
    if (this._transitioning) return false;
    this._transitioning = true;
    this._lastVia = exit.id ?? 'exit';
    try {
      // W5-AUDIO: heavy stone door on the way through the exit.
      try { this._deps.audioManager?.playSfx?.('door', { channel: 'environment', volume: 0.7 }); } catch { /* audio optional */ }
      await this._fade(180, true);
      await this.loadRoom(exit.target, exit.spawn ?? null);
      await this._fade(180, false);
    } finally {
      this._transitioning = false;
    }
    return true;
  }

  /** Tear down live entities of the current room (pool release, body destroy). */
  unloadCurrentRoom() {
    if (this.room) {
      try {
        this.room.destroy();
      } catch (err) {
        console.warn('[RoomManager] room.destroy() threw:', err?.message);
      }
      this.room = null;
    }
    try {
      this._projectileSystem?.clear?.();
    } catch { /* never break teardown */ }
    this.currentRoomId = null;
  }

  /** @param {number} dt seconds — called by GameScene.update */
  update(dt) {
    try {
      this.room?.update(dt);
    } catch (err) {
      console.warn('[RoomManager] room.update() threw:', err?.message);
    }
  }

  // --------------------------------------------------------------- spawning

  /**
   * Spawn a pickup in the live room (enemy/breakable/secret drops).
   * Signature matches the Enemy/Breakable ctx contract: (x, y, ref).
   * @param {number} x @param {number} y
   * @param {string} ref pickup ref ('coin'|'heart'|'mana'|'key'|<itemId>)
   * @param {object} [opts] { quantity?, temporary? } (temporary defaults true)
   * @returns {object|null} the Pickup, or null when no room is live
   */
  spawnPickup(x, y, ref, opts = {}) {
    if (!this.room || !this.scene) return null;
    const { gameState: gs } = this._deps;
    const pickup = new Pickup(this.scene, ref, x, y, {
      gameState: gs,
      quantity: opts.quantity ?? 1,
      temporary: opts.temporary ?? true,
    });
    this.room.pickups.push(pickup);
    return pickup;
  }

  /** @private enemy died: prune + unregister from shared systems */
  _onEnemyDeath(enemy) {
    if (!enemy || !this.room) return;
    this.room.enemies = this.room.enemies.filter((e) => e !== enemy);
    try {
      this._effectsManager?.unregisterVictim?.(enemy.instanceId);
    } catch { /* optional */ }
    try {
      this._hitboxSystem?.unregisterHurtbox?.(enemy);
    } catch { /* optional */ }
  }

  // ---------------------------------------------------------------- visuals

  /** @private camera fade with a hard timeout (never hangs the transition) */
  _fade(ms, out) {
    const cam = this.scene?.cameras?.main;
    if (!cam?.fadeOut) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) { done = true; resolve(); }
      };
      const timer = setTimeout(finish, ms + 150);
      try {
        const evt = out ? 'camerafadeoutcomplete' : 'camerafadeincomplete';
        cam.once(evt, () => { clearTimeout(timer); finish(); });
        if (out) cam.fadeOut(ms, 0, 0, 0);
        else cam.fadeIn(ms, 0, 0, 0);
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }

  /**
   * @private blocked-exit feedback: shimmer at the exit rect + hint text.
   * Never throws; no-ops without a scene.
   */
  _showBlocked(exit, check) {
    const now = Date.now();
    if (now - (this._blockedAt.get(exit.id) ?? 0) < BLOCKED_COOLDOWN_MS) return;
    this._blockedAt.set(exit.id, now);
    const scene = this.scene;
    if (!scene?.add) return;
    try {
      const gfx = scene.add.rectangle(
        exit.x + exit.w / 2, exit.y + exit.h / 2, exit.w, exit.h, 0x9db8ff, 0.25,
      );
      gfx.setDepth(20);
      scene.tweens?.add({
        targets: gfx, alpha: 0.7, duration: 120, yoyo: true, repeat: 2,
        onComplete: () => gfx.destroy(),
      });
      const label = scene.add.text(
        exit.x + exit.w / 2, exit.y - 14, check.hint ?? 'Sealed.',
        { fontSize: '8px', color: '#cfe3ff', align: 'center', wordWrap: { width: 200 } },
      );
      label.setOrigin(0.5, 1).setDepth(21);
      scene.tweens?.add({
        targets: label, alpha: 0, y: label.y - 10, duration: 1400,
        onComplete: () => label.destroy(),
      });
    } catch { /* cosmetic only */ }
  }

  /**
   * Spawn one extra enemy into the live room (W4-BOSS: boss summons).
   * Reuses Room's normal spawn path: hurtbox, victim registry, colliders,
   * and the RoomManager onEnemyDeath hook all apply.
   * @param {string} enemyId enemy id from data/enemies.json
   * @param {number} x @param {number} y spawn position (feet)
   * @returns {object|null} the spawned enemy, or null when no room is live
   */
  spawnEnemy(enemyId, x, y) {
    if (!this.room || !this.scene) return null;
    this.room.spawnEnemy(enemyId, x, y);
    return this.room.enemies[this.room.enemies.length - 1] ?? null;
  }

  /**
   * Seal the current room's exits (W4-BOSS: boss fights). While locked,
   * requestExit() shows a shimmer and refuses the transition.
   * @param {string} [reason='boss'] lock reason (debug-readable)
   */
  lockExits(reason = 'boss') {
    this.exitLock = reason;
  }

  /** Release a lockExits() seal. */
  unlockExits() {
    this.exitLock = null;
  }

  /** @returns {boolean} true while exits are sealed */
  get exitsLocked() {
    return this.exitLock !== null;
  }

  /** @returns {boolean} true while a transition is in flight */
  get isTransitioning() {
    return this._transitioning;
  }

  /** @param {string} secretId @returns {boolean} */
  isSecretFound(secretId) {
    return !!this._deps.gameState.getFlag(secretFlag(secretId));
  }
}
