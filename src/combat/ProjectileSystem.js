/**
 * ProjectileSystem — pooled projectiles (docs/ARCHITECTURE.md §9, spec §56).
 *
 * CONTRACT:
 * - Object pool: prewarm(n) at room load; update() allocates nothing.
 *   fire() may grow the pool if exhausted (documented fallback — better than
 *   silently dropping a player's spell mid-fight).
 * - fire(spec): spec =
 *     { x, y, vx, vy, w?, h?, damage, type?, fromPlayer?, sprite?, texture?,
 *       lifeMs?, gravity?, pierce?, critChance?, hitStun?, ownerId?,
 *       source?, onHit? }
 *   `damage` is a number (raw amount) or a DamageSystem opts object.
 *   `type` is a shortcut merged into damage opts when damage is a number.
 *   `sprite` attaches an existing GameObject; `texture` + scene creates one
 *   (owned by the pool, hidden on release). Headless-safe: no sprite needed.
 * - update(dt): integrates motion, ages, culls expired/far-off-screen back
 *   to the pool. Off-screen projectiles SKIP collision (spec §56) but keep
 *   flying until life expires or they leave the cull margin.
 * - clear(): deactivate everything (room teardown). shutdown(): clear +
 *   destroy owned sprites.
 *
 * COLLISION DESIGN (documented choice): when constructed with a HitboxSystem,
 * projectiles collide against ITS hurtbox registry — one source of truth for
 * hurtboxes, no duplicate registration. Without one (standalone/headless),
 * registerTarget(entity, box?) maintains a local list. Team filtering:
 * fromPlayer projectiles hit kind 'enemy'|'boss'; hostile projectiles hit
 * kind 'player'. Per-target hit-once always; `pierce` counts DISTINCT
 * targets (default 1).
 *
 * No Phaser imports at module level; all scene/sprite access is duck-typed
 * and optional, so logic is unit-testable in node.
 */
import { DamageSystem } from './DamageSystem.js';

function entityIdOf(entity) {
  return entity?.id ?? entity?.instanceId ?? null;
}

/** AABB overlap on duck-typed {x,y,width,height} rects. */
function aabb(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export class ProjectileSystem {
  /**
   * @param {Phaser.Scene|null} scene owning scene (null in headless tests)
   * @param {import('./HitboxSystem.js').HitboxSystem|null} hitboxSystem
   *   hurtbox registry source; omit for standalone target list
   */
  constructor(scene = null, hitboxSystem = null) {
    this.scene = scene;
    this.hitboxSystem = hitboxSystem;
    /** @type {object[]} every projectile record, active or pooled */
    this._pool = [];
    /** standalone hurtbox records when no HitboxSystem: Map<id, {entity, box}> */
    this._targets = new Map();
    this._rectP = { x: 0, y: 0, width: 0, height: 0 };
    this._rectT = { x: 0, y: 0, width: 0, height: 0 };
    // Pre-bound collision callback + current-projectile slot: lets update()
    // iterate hurtboxes with zero per-frame allocation (no closures).
    this._collideTarget = this._collideTarget.bind(this);
    /** @type {object|null} projectile currently being collision-tested */
    this._cp = null;
  }

  /** Build one pooled record (inactive). */
  _makeRecord() {
    return {
      active: false,
      x: 0, y: 0, vx: 0, vy: 0, w: 8, h: 8,
      gravity: 0,
      life: 2, age: 0,
      fromPlayer: true,
      source: null,
      damage: null,
      pierce: 1,
      hitIds: null, // Set<string> — allocated in fire(), never in update()
      onHit: null,
      sprite: null,
      ownSprite: false,
    };
  }

  /** @param {number} count pre-allocate pool entries */
  prewarm(count) {
    for (let i = 0; i < count; i++) this._pool.push(this._makeRecord());
  }

  /**
   * Standalone-mode target registration (ignored when a HitboxSystem is set).
   * @param {object} entity needs id/kind + takeDamage/getDefense/isInvulnerable
   * @param {{w:number,h:number,offsetX?:number,offsetY?:number}} [box]
   */
  registerTarget(entity, box = null) {
    const id = entityIdOf(entity);
    if (!id) throw new Error('[ProjectileSystem] registerTarget: entity needs an id');
    this._targets.set(id, { entity, box: box ?? { w: 16, h: 16, offsetX: 0, offsetY: 0 } });
  }

  /** @param {object} entity */
  unregisterTarget(entity) {
    const id = entityIdOf(entity);
    if (id) this._targets.delete(id);
  }

  /**
   * @param {object} spec see CONTRACT
   * @returns {object} projectile handle (pooled record; do not retain)
   */
  fire(spec) {
    if (spec == null) throw new Error('[ProjectileSystem] fire requires a spec');
    let p = null;
    for (const rec of this._pool) {
      if (!rec.active) { p = rec; break; }
    }
    if (!p) {
      // Pool exhausted: grow rather than drop the shot (documented).
      p = this._makeRecord();
      this._pool.push(p);
    }

    p.active = true;
    p.x = spec.x ?? 0;
    p.y = spec.y ?? 0;
    p.vx = spec.vx ?? 0;
    p.vy = spec.vy ?? 0;
    p.w = spec.w ?? 8;
    p.h = spec.h ?? 8;
    p.gravity = spec.gravity ?? 0;
    p.life = (spec.lifeMs ?? 2000) / 1000;
    p.age = 0;
    p.fromPlayer = spec.fromPlayer !== false;
    p.source = spec.source ?? {
      id: spec.ownerId ?? 'unknown',
      kind: p.fromPlayer ? 'player' : 'enemy',
    };
    if (typeof spec.damage === 'number') {
      p.damage = { amount: spec.damage, type: spec.type ?? 'physical' };
    } else {
      p.damage = { amount: 0, type: 'physical', ...(spec.damage ?? {}) };
      if (spec.type !== undefined && spec.damage?.type === undefined) p.damage.type = spec.type;
    }
    if (p.damage.critChance === undefined) p.damage.critChance = spec.critChance ?? 0;
    if (p.damage.hitStun === undefined) p.damage.hitStun = spec.hitStun ?? 0;
    p.pierce = Math.max(1, Math.floor(spec.pierce ?? 1));
    p.hitIds = new Set();
    p.onHit = spec.onHit ?? null;

    // Visual attachment (optional; logic runs headless without it).
    if (spec.sprite) {
      p.sprite = spec.sprite;
      p.ownSprite = false;
      if (typeof p.sprite.setVisible === 'function') p.sprite.setVisible(true);
    } else if (spec.texture && this.scene && typeof this.scene.add?.image === 'function') {
      p.sprite = this.scene.add.image(p.x, p.y, spec.texture);
      p.ownSprite = true;
    } else {
      p.sprite = null;
      p.ownSprite = false;
    }
    this._syncSprite(p);
    return p;
  }

  _syncSprite(p) {
    if (!p.sprite) return;
    if (typeof p.sprite.setPosition === 'function') p.sprite.setPosition(p.x, p.y);
    else { p.sprite.x = p.x; p.sprite.y = p.y; }
  }

  _release(p) {
    p.active = false;
    p.hitIds = null;
    p.onHit = null;
    if (p.sprite) {
      if (p.ownSprite && typeof p.sprite.destroy === 'function') p.sprite.destroy();
      else if (typeof p.sprite.setVisible === 'function') p.sprite.setVisible(false);
      p.sprite = null;
      p.ownSprite = false;
    }
  }

  /** Camera world view, or null when unavailable (headless → no culling). */
  _worldView() {
    const cam = this.scene?.cameras?.main;
    return cam?.worldView ?? null;
  }

  /** Off-screen margin (px): beyond this, projectiles skip collision. */
  static CULL_MARGIN = 64;

  _onScreen(p) {
    const v = this._worldView();
    if (!v) return true; // no camera info: never skip collision headless
    const m = ProjectileSystem.CULL_MARGIN;
    return p.x > v.x - m && p.x < v.x + v.width + m && p.y > v.y - m && p.y < v.y + v.height + m;
  }

  _entityRect(entity, box, out) {
    if (typeof entity.getBounds === 'function') {
      const b = entity.getBounds();
      out.x = b.x; out.y = b.y; out.width = b.width; out.height = b.height;
      return;
    }
    const w = box?.w ?? entity.w ?? 16;
    const h = box?.h ?? entity.h ?? 16;
    out.width = w; out.height = h;
    out.x = (entity.x ?? 0) + (box?.offsetX ?? 0) - w / 2;
    out.y = (entity.y ?? 0) + (box?.offsetY ?? 0) - h / 2;
  }

  _collide(p) {
    const R = this._rectP;
    R.x = p.x - p.w / 2; R.y = p.y - p.h / 2; R.width = p.w; R.height = p.h;
    // Zero-allocation sweep: the bound _collideTarget reads this._cp.
    this._cp = p;
    if (this.hitboxSystem) {
      this.hitboxSystem.forEachHurtbox(this._collideTarget);
    } else {
      for (const rec of this._targets.values()) this._collideTarget(rec.entity, rec.box);
    }
    this._cp = null;
  }

  /** @param {object} entity @param {object} box fallback box (standalone mode) */
  _collideTarget(entity, box) {
    const p = this._cp;
    if (!p || !p.active) return; // pierce exhausted mid-sweep
    const id = entityIdOf(entity);
    if (!id || p.hitIds.has(id)) return;
    const kind = entity.kind ?? 'enemy';
    if (p.fromPlayer) {
      if (kind !== 'enemy' && kind !== 'boss') return;
    } else if (kind !== 'player') {
      return;
    }
    this._entityRect(entity, box, this._rectT);
    if (!aabb(this._rectP, this._rectT)) return;
    p.hitIds.add(id);
    DamageSystem.applyDamage(p.source, entity, p.damage);
    if (typeof p.onHit === 'function') p.onHit(entity);
    p.pierce -= 1;
    if (p.pierce <= 0) this._release(p);
  }

  /** @param {number} dt seconds */
  update(dt) {
    for (const p of this._pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { this._release(p); continue; }

      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      this._syncSprite(p);

      // Spec §56: off-screen projectiles skip collision. They keep flying
      // until life expiry reaps them (lifeMs bounds every shot).
      if (!this._onScreen(p)) continue;

      this._collide(p);
    }
  }

  /** @returns {number} projectiles currently in flight (debug overlay) */
  getActiveCount() {
    let n = 0;
    for (const p of this._pool) if (p.active) n++;
    return n;
  }

  /** Deactivate everything (room teardown). Pool entries are retained. */
  clear() {
    for (const p of this._pool) if (p.active) this._release(p);
  }

  shutdown() {
    this.clear();
    this._pool.length = 0;
    this._targets.clear();
  }
}
