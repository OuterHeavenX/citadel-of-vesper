/**
 * Room — runtime wrapper around one room definition.
 *
 * CONTRACT:
 * - Built by RoomManager from data/rooms.json entries (see docs/ROOM_FORMAT.md).
 * - Owns: tilemap layers, collision setup, spawned enemies (via EnemyFactory),
 *   pickups, breakables, secrets, checkpoints, exit/hazard/secret trigger zones.
 * - update(dt): ticks room-local logic (pickup magnet/bob, parallax scroll);
 *   enemies tick through their own AI — Room never implements AI.
 * - destroy(): releases everything created by build().
 *
 * Geometry: data/rooms.json carries rect lists (geometry.solids/oneway/hazards).
 * Room paints them into a Phaser tilemap using the region tileset
 * (assets/tilesets/<region>_tiles.png, key `tiles_<region>`) and the bundled
 * name->index map. When the tileset texture is missing, Room falls back to
 * invisible Arcade static rect bodies so collision still works (spec §59).
 *
 * Wave 3 implements.
 */
import { gameState } from '../core/GameState.js';
import { eventBus } from '../core/EventBus.js';
import { EnemyFactory } from '../enemies/EnemyFactory.js';
import { Breakable } from '../props/Breakable.js';
import { Pickup } from '../props/Pickup.js';
import { DamageSystem } from '../combat/DamageSystem.js';
import mgTiles from '../../assets/tilesets/moonlit_gate_tiles.json';
import hkTiles from '../../assets/tilesets/hollow_keep_tiles.json';

/** region -> tileset name->index map (bundled statically by Vite). */
const TILE_INDEX = {
  moonlit_gate: mgTiles.tiles,
  hollow_keep: hkTiles.tiles,
};

const TILE = 16;

/**
 * Wave 5: deterministic cosmetic variants painted during geometry tiling.
 * region -> base tile name -> weighted [name] pool. Keeps collision identical
 * (variants are visual only); seeded by room id so rooms are stable.
 */
const TILE_VARIANTS = {
  moonlit_gate: {
    stone_inner: ['stone_inner', 'stone_inner', 'stone_inner', 'stone_inner_cracked', 'stone_inner_moss'],
    plat_top: ['plat_top', 'plat_top', 'plat_top', 'plat_top_cracked'],
  },
  hollow_keep: {
    stone_inner: ['stone_inner', 'stone_inner', 'stone_inner', 'basalt_cracked', 'basalt_cracked_b'],
    plat_top: ['plat_top', 'plat_top', 'plat_top', 'plat_top_iron_cracked'],
  },
};

/** Deterministic 0..1 hash from tile coords + room seed. */
function hash01(tx, ty, seed) {
  let h = (tx * 374761393 + ty * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967296;
}

/** Numeric seed from a room id string. */
function roomSeed(roomId) {
  let h = 0;
  for (let i = 0; i < roomId.length; i++) h = ((h * 31 + roomId.charCodeAt(i)) | 0);
  return h | 0;
}

/** Secret flag key for a secret id (one-time discovery). */
export function secretFlag(secretId) {
  return `secret:${secretId}`;
}

export class Room {
  /** @param {Phaser.Scene} scene @param {object} def room definition JSON */
  constructor(scene, def) {
    this.scene = scene;
    this.def = def;
    this.roomId = def.id;
    /** @type {object|null} build ctx from RoomManager */
    this.ctx = null;
    this.enemies = [];
    this.pickups = [];
    this.breakables = [];
    /** @type {Array<{zone:object, collider:object}>} trigger zones */
    this._zones = [];
    /** @type {Array<object>} extra physics colliders to remove */
    this._colliders = [];
    /** tilemap pieces (or null when using the rect-body fallback) */
    this._tiles = null;
    /** parallax tileSprites */
    this._parallax = [];
    /** ambient particle emitter (region dust/embers) */
    this._ambience = null;
    /** hazard id -> last damage time (s) */
    this._hazardCd = new Map();
  }

  // ------------------------------------------------------------------ build

  /**
   * Build tilemap, collision, entities.
   * @param {object} ctx { getPlayer, hitboxSystem, projectileSystem,
   *   effectsManager?, onExit(exit), spawnPickup(x,y,ref), onEnemyDeath(enemy) }
   */
  build(ctx) {
    this.ctx = ctx;
    const scene = this.scene;
    const def = this.def;

    scene.physics.world.setBounds(0, 0, def.width, def.height);

    const geom = def.geometry ?? {};
    if (!this._buildTilemap(geom)) this._buildFallbackBodies(geom);

    this._buildSecretBlockers(def.secrets ?? []);
    this._buildZones('exit', def.exits ?? [], (exit) => this._onExitZone(exit));
    this._buildZones('hazard', geom.hazards ?? [], (hz, i) => this._onHazardZone(hz, i));
    this._buildZones('checkpoint', def.checkpoints ?? [], (cp) => {
      gameState.setCheckpoint(cp.id, this.roomId, cp.x, cp.y);
    });
    this._buildZones('secret', def.secrets ?? [], (secret) => this._discoverSecret(secret));

    for (const b of def.breakables ?? []) {
      this.breakables.push(
        new Breakable(scene, b.kind, b.x, b.y, {
          spawnPickup: (x, y, ref) => ctx.spawnPickup(x, y, ref),
        }),
      );
    }

    (def.pickups ?? []).forEach((p, i) => {
      const chestId = `chest:${this.roomId}:${i}`;
      if (p.chest && gameState.data.chestStates[chestId]) return; // already looted
      const pickup = new Pickup(scene, p.itemId, p.x, p.y, {
        gameState,
        quantity: p.quantity ?? 1,
        temporary: false,
        onCollect: p.chest ? () => gameState.setChestState(chestId, true) : null,
      });
      this.pickups.push(pickup);
    });

    this._spawnEnemies(def.enemies ?? []);
    this._buildParallax();
    this._buildAmbience();
    return this;
  }

  // ------------------------------------------------------------------ update

  /** @param {number} dt seconds */
  update(dt) {
    if (dt <= 0) return;
    const player = this.ctx?.getPlayer?.() ?? null;
    const ppos = player ? player.getPosition() : null;
    // Enemies tick through their own AI — Room only orchestrates the call.
    for (const e of this.enemies) {
      try {
        e.update(dt, ppos);
      } catch { /* one bad enemy never stalls the room */ }
    }
    for (const p of this.pickups) {
      if (!p.destroyed) p.update(dt, ppos);
    }
    // Prune collected/destroyed pickups (no per-frame allocation).
    if (this.pickups.some((p) => p.destroyed || p.collected)) {
      this.pickups = this.pickups.filter((p) => !p.destroyed && !p.collected);
    }
    // Parallax follows the camera (tileSprites are scrollFactor(0)).
    const cam = this.scene?.cameras?.main;
    if (cam && this._parallax.length > 0) {
      this._parallax[0].tilePositionX = cam.scrollX * 0.25;
      this._parallax[0].tilePositionY = cam.scrollY * 0.15;
      if (this._parallax[1]) {
        this._parallax[1].tilePositionX = cam.scrollX * 0.55;
        this._parallax[1].tilePositionY = cam.scrollY * 0.3;
      }
    }
  }

  // ---------------------------------------------------------------- destroy

  destroy() {
    const scene = this.scene;
    for (const e of this.enemies) {
      try {
        this.ctx?.effectsManager?.unregisterVictim?.(e.instanceId);
      } catch { /* never break teardown */ }
      try {
        this.ctx?.hitboxSystem?.unregisterHurtbox?.(e);
      } catch { /* never break teardown */ }
      try {
        e.destroy();
      } catch { /* never break teardown */ }
    }
    this.enemies = [];
    for (const p of this.pickups) {
      try { p.destroy(); } catch { /* never break teardown */ }
    }
    this.pickups = [];
    for (const b of this.breakables) {
      try { b.destroy(); } catch { /* never break teardown */ }
    }
    this.breakables = [];
    for (const { zone, collider } of this._zones) {
      try { if (collider) scene.physics.world.removeCollider(collider); } catch { /* noop */ }
      try { zone.destroy(); } catch { /* noop */ }
    }
    this._zones = [];
    for (const c of this._colliders) {
      try { scene.physics.world.removeCollider(c); } catch { /* noop */ }
    }
    this._colliders = [];
    if (this._tiles) {
      try { this._tiles.map.destroy(); } catch { /* noop */ }
      this._tiles = null;
    }
    for (const t of this._parallax) {
      try { t.destroy(); } catch { /* noop */ }
    }
    this._parallax = [];
    try { this._ambience?.destroy(); } catch { /* noop */ }
    this._ambience = null;
    this.ctx = null;
  }

  // ------------------------------------------------------------------ tiles

  /** @private paint geometry into a tilemap; false when tileset missing */
  _buildTilemap(geom) {
    const scene = this.scene;
    const def = this.def;
    const texKey = `tiles_${def.region}`;
    const indexMap = TILE_INDEX[def.region];
    if (!indexMap || !scene.textures?.exists(texKey)) return false;

    let map, tileset, solidLayer, onewayLayer;
    try {
      map = scene.make.tilemap({
        tileWidth: TILE,
        tileHeight: TILE,
        width: Math.ceil(def.width / TILE),
        height: Math.ceil(def.height / TILE),
      });
      tileset = map.addTilesetImage('tiles', texKey, TILE, TILE);
      solidLayer = map.createBlankLayer('solid', tileset);
      onewayLayer = map.createBlankLayer('oneway', tileset);
      solidLayer.setDepth(2);
      onewayLayer.setDepth(2);
    } catch {
      return false;
    }

    const idx = (name) => indexMap[name]?.index ?? -1;
    const seed = roomSeed(this.roomId ?? '');
    const variants = TILE_VARIANTS[def.region] ?? {};
    /** Resolve a base tile name to a deterministic cosmetic variant index. */
    const vidx = (base, tx, ty) => {
      const pool = variants[base];
      if (!pool) return idx(base);
      const pick = pool[Math.floor(hash01(tx, ty, seed) * pool.length) % pool.length];
      return idx(pick);
    };
    const putSolid = (tx, ty, tile) => {
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return;
      solidLayer.putTileAt(tile, tx, ty);
    };

    // Solids: top row = platform caps, interior = stone.
    for (const r of geom.solids ?? []) {
      const x0 = Math.floor(r.x / TILE), x1 = Math.ceil((r.x + r.w) / TILE) - 1;
      const y0 = Math.floor(r.y / TILE), y1 = Math.ceil((r.y + r.h) / TILE) - 1;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (ty === y0) {
            putSolid(tx, ty, tx === x0 ? idx('plat_top_left') : tx === x1 ? idx('plat_top_right') : vidx('plat_top', tx, ty));
          } else {
            putSolid(tx, ty, vidx('stone_inner', tx, ty));
          }
        }
      }
    }
    // One-way platforms: single plat_top row.
    for (const p of geom.oneway ?? []) {
      const y = Math.floor(p.y / TILE);
      const x0 = Math.floor(p.x / TILE), x1 = Math.ceil((p.x + p.w) / TILE) - 1;
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || tx >= map.width || y < 0 || y >= map.height) continue;
        onewayLayer.putTileAt(vidx('plat_top', tx, y), tx, y);
      }
    }

    solidLayer.setCollisionByExclusion([-1]);
    onewayLayer.setCollisionByExclusion([-1]);
    // One-way: collide from above only.
    onewayLayer.forEachTile((tile) => {
      if (tile.index === -1) return;
      tile.collideUp = true;
      tile.collideDown = false;
      tile.collideLeft = false;
      tile.collideRight = false;
    });

    // Player + enemies collide with both layers.
    const player = this.ctx?.getPlayer?.();
    const ps = player?.getSprite?.() ?? null;
    if (ps?.body) {
      this._colliders.push(scene.physics.add.collider(ps, solidLayer));
      this._colliders.push(scene.physics.add.collider(ps, onewayLayer));
    }

    this._tiles = { map, solidLayer, onewayLayer };
    return true;
  }

  /** @private invisible static rect bodies when the tileset is unavailable */
  _buildFallbackBodies(geom) {
    const scene = this.scene;
    const group = scene.physics.add.staticGroup();
    const addRect = (x, y, w, h) => {
      const z = scene.add.zone(x + w / 2, y + h / 2, w, h);
      scene.physics.add.existing(z, true);
      group.add(z);
      this._zones.push({ zone: z, collider: null }); // destroyed with the room
    };
    for (const r of geom.solids ?? []) addRect(r.x, r.y, r.w, r.h);
    for (const p of geom.oneway ?? []) addRect(p.x, p.y, p.w, 8);
    const player = this.ctx?.getPlayer?.();
    const ps = player?.getSprite?.() ?? null;
    if (ps?.body) this._colliders.push(scene.physics.add.collider(ps, group));
    this._fallbackGroup = group;
  }

  /** @private paint cracked blocking tiles over undiscovered breakable walls */
  _buildSecretBlockers(secrets) {
    if (!this._tiles) return;
    const { solidLayer, map } = this._tiles;
    const indexMap = TILE_INDEX[this.def.region];
    const cracked = indexMap?.['stone_brick_cracked']?.index ?? -1;
    if (cracked < 0) return;
    for (const s of secrets) {
      if (s.kind !== 'breakable_wall') continue;
      if (gameState.getFlag(secretFlag(s.id))) continue; // already opened
      const x0 = Math.floor(s.x / TILE), x1 = Math.ceil((s.x + s.w) / TILE) - 1;
      const y0 = Math.floor(s.y / TILE), y1 = Math.ceil((s.y + s.h) / TILE) - 1;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
          solidLayer.putTileAt(cracked, tx, ty);
        }
      }
    }
    solidLayer.setCollisionByExclusion([-1]);
  }

  /** @private remove the tiles covering a discovered secret rect */
  _clearSecretTiles(secret) {
    if (!this._tiles) return;
    const { solidLayer, onewayLayer, map } = this._tiles;
    const x0 = Math.floor(secret.x / TILE), x1 = Math.ceil((secret.x + secret.w) / TILE) - 1;
    const y0 = Math.floor(secret.y / TILE), y1 = Math.ceil((secret.y + secret.h) / TILE) - 1;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
        // Never carve below the room's own floor for hidden_floor caches on
        // platforms: only clear what the secret rect covers.
        solidLayer.removeTileAt(tx, ty);
        onewayLayer.removeTileAt(tx, ty);
      }
    }
  }

  // ------------------------------------------------------------------ zones

  /** @private create overlap zones for a list of rect defs */
  _buildZones(kind, defs, onOverlap) {
    const scene = this.scene;
    const player = this.ctx?.getPlayer?.();
    const ps = player?.getSprite?.() ?? null;
    if (!ps?.body) return;
    defs.forEach((d, i) => {
      const zone = scene.add.zone(d.x + d.w / 2, d.y + d.h / 2, d.w, d.h);
      scene.physics.add.existing(zone, true);
      let collider = null;
      try {
        collider = scene.physics.add.overlap(ps, zone, () => onOverlap(d, i));
      } catch {
        zone.destroy();
        return;
      }
      this._zones.push({ zone, collider, kind });
    });
  }

  /** @private exit zone fired */
  _onExitZone(exit) {
    if (exit.secretId && !gameState.getFlag(secretFlag(exit.secretId))) return;
    this.ctx?.onExit?.(exit);
  }

  /** @private hazard zone fired — environment damage with a short cooldown */
  _onHazardZone(hz, i) {
    const now = this.scene?.time?.now ?? 0;
    const key = `hz${i}`;
    if (now - (this._hazardCd.get(key) ?? -1000) < 600) return;
    this._hazardCd.set(key, now);
    const player = this.ctx?.getPlayer?.() ?? null;
    if (!player) return;
    DamageSystem.applyDamage(
      { id: 'environment', kind: 'environment' },
      player,
      { amount: hz.damage ?? 10, type: 'physical', knockback: { x: 0, y: -120 } },
    );
  }

  /** @private secret zone fired — one-time discovery */
  _discoverSecret(secret) {
    const flag = secretFlag(secret.id);
    if (gameState.getFlag(flag)) return;
    gameState.setFlag(flag, true);
    eventBus.emit('room:secretFound', { roomId: this.roomId, secretId: secret.id });
    this._clearSecretTiles(secret);
    const reward = secret.reward;
    if (reward?.itemId) {
      this.ctx?.spawnPickup?.(secret.x + secret.w / 2, secret.y - 8, reward.itemId, {
        quantity: reward.quantity ?? 1,
      });
    } else if (reward?.abilityId) {
      // Ability rewards unlock immediately (no pickup object needed).
      eventBus.emit('player:abilityUnlocked', { abilityId: reward.abilityId });
    }
  }

  // ---------------------------------------------------------------- enemies

  /** @private spawn room enemies via EnemyFactory */
  _spawnEnemies(list) {
    const scene = this.scene;
    const ctx = this.ctx;
    list.forEach((e, i) => {
      const instanceId = `${this.roomId}:${i}`;
      let enemy;
      try {
        enemy = EnemyFactory.create(e.id, scene, e.x, e.y, instanceId, {
          roomId: this.roomId,
          getPlayer: () => ctx.getPlayer?.() ?? null,
          projectileSystem: ctx.projectileSystem ?? null,
          hitboxSystem: ctx.hitboxSystem ?? null,
          spawnPickup: (x, y, ref) => ctx.spawnPickup?.(x, y, ref),
          onDeath: (dead) => ctx.onEnemyDeath?.(dead),
        });
      } catch (err) {
        console.warn(`[Room] enemy spawn failed (${e.id}):`, err?.message);
        return;
      }
      this.enemies.push(enemy);
      // Victim registry for hit flashes (effectsManager contract).
      try {
        ctx.effectsManager?.registerVictim?.(instanceId, enemy.sprite ?? enemy.getSprite?.() ?? null);
      } catch { /* optional */ }
      // Hurtbox so player attacks can land on it.
      try {
        ctx.hitboxSystem?.registerHurtbox?.(enemy, { w: 20, h: 28, offsetX: 0, offsetY: -14 });
      } catch { /* optional */ }
      // Collide with the tile layers.
      try {
        const sprite = enemy.sprite ?? enemy.getSprite?.() ?? null;
        if (sprite?.body && this._tiles) {
          this._colliders.push(scene.physics.add.collider(sprite, this._tiles.solidLayer));
          this._colliders.push(scene.physics.add.collider(sprite, this._tiles.onewayLayer));
        }
      } catch { /* optional */ }
    });
  }

  /**
   * Spawn one extra enemy into the live room (W4-BOSS: boss summons).
   * Uses the same path as room-load spawns: EnemyFactory, victim registry,
   * hurtbox registration, tile colliders, and the onEnemyDeath hook.
   * @param {string} enemyId enemy id from data/enemies.json
   * @param {number} x @param {number} y spawn position (feet)
   */
  spawnEnemy(enemyId, x, y) {
    this._spawnEnemies([{ id: enemyId, x, y }]);
  }

  // --------------------------------------------------------------- parallax

  /** @private two parallax layers; missing textures are skipped silently */
  _buildParallax() {
    const scene = this.scene;
    const def = this.def;
    const w = def.width, h = def.height;
    const specs = [
      { key: `bg_${def.region}_far`, depth: -10 },
      { key: `bg_${def.region}_near`, depth: -9 },
    ];
    for (const { key, depth } of specs) {
      try {
        if (!scene.textures?.exists(key)) continue;
        const t = scene.add.tileSprite(0, 0, w, h, key).setOrigin(0, 0);
        t.setScrollFactor(0).setDepth(depth);
        this._parallax.push(t);
      } catch { /* optional art */ }
    }
  }

  /**
   * Wave 5: lightweight region atmosphere. Hollow Keep gets drifting ash
   * and rising embers; Moonlit Gate gets faint moonlit motes. A single
   * particle emitter, torn down in destroy().
   */
  _buildAmbience() {
    const scene = this.scene;
    const def = this.def;
    try {
      const texKey = 'fx_ambient_mote';
      if (!scene.textures?.exists(texKey)) {
        const g = scene.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(0xffffff, 1);
        g.fillCircle(3, 3, 3);
        g.generateTexture(texKey, 6, 6);
        g.destroy();
      }
      const isKeep = def.region === 'hollow_keep';
      const emitter = scene.add.particles(0, 0, texKey, {
        x: { min: 0, max: def.width },
        y: { min: 0, max: def.height },
        lifespan: { min: 2600, max: 5200 },
        speedY: isKeep ? { min: -20, max: -5 } : { min: -9, max: -2 },
        speedX: { min: -14, max: 14 },
        scale: { min: 0.35, max: 1.0 },
        alpha: { min: 0.12, max: 0.45 },
        tint: isKeep ? [0xff9a3c, 0xffd773, 0x9a8f80] : [0xbcd0ff, 0x8a9ac8],
        frequency: isKeep ? 200 : 420,
        blendMode: 'ADD',
      });
      emitter.setDepth(8);
      this._ambience = emitter;
    } catch { /* ambience is cosmetic; never break room build */ }
  }
}
