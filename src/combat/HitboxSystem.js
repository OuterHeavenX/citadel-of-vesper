/**
 * HitboxSystem — attack hitboxes vs. entity hurtboxes (docs/ARCHITECTURE.md §9).
 *
 * CONTRACT:
 * - spawnHitbox(owner, spec): registers an attack hitbox that follows the
 *   owner. spec:
 *     { w, h,                          // hitbox size (px)
 *       offsetX?, offsetY?,            // offset from owner position (sprite
 *                                      // center); offsetX mirrors with facing
 *       duration,                      // total lifetime (s), then despawned
 *       activeFrom?, activeTo?,         // damage window within duration (s);
 *                                      // defaults: 0 .. duration
 *       damage,                        // DamageSystem opts { amount, type,
 *                                      //   knockback, critical/canCrit/
 *                                      //   critChance, hitStun }
 *       type?, knockback?,             // shortcuts merged into damage opts
 *       hitOnce?,                      // default true — each (hitbox, target)
 *                                      // pair hits at most once
 *       source?,                       // { id, kind } override; default
 *                                      // derived from owner.id / owner.kind
 *       id? }                          // optional explicit hitbox id
 *   Damage may ONLY occur during [activeFrom, activeTo] — anticipation and
 *   recovery frames never deal damage.
 * - registerHurtbox(entity, box): entity exposes
 *     { id, kind, getBounds: () => Rectangle-like {x,y,width,height},
 *       takeDamage, getDefense, isInvulnerable }.
 *   `box` ({w,h,offsetX?,offsetY?}) is a fallback used only when the entity
 *   has no getBounds(); it is also drawn by drawDebug when provided.
 * - update(dt): advances hitboxes, runs AABB checks with NO per-frame
 *   allocation (two scratch rects are reused).
 * - drawDebug(graphics): hitboxes red while in their active window, amber
 *   otherwise; hurtboxes green. Duck-typed graphics (lineStyle/strokeRect).
 * - despawnHitbox(id): cancel a single hitbox (used by PlayerCombat.cancelOnHit).
 * - forEachHurtbox(fn): public read accessor — ProjectileSystem collides
 *   against this registry so hurtboxes have a single source of truth.
 *
 * No Phaser imports at module level: pure logic + duck-typed rects, so this
 * file is unit-testable in node with fake entities.
 */
import { DamageSystem } from './DamageSystem.js';

let nextHitboxId = 1;

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

export class HitboxSystem {
  /** @param {Phaser.Scene|null} scene owning scene (may be null in tests) */
  constructor(scene = null) {
    this.scene = scene;
    /** @type {Map<string, object>} hitbox id -> record */
    this._hitboxes = new Map();
    /** @type {Map<string, {entity:object, box:object}>} entity id -> hurtbox */
    this._hurtboxes = new Map();
    // Scratch rects — reused every frame, never allocated in update().
    this._rectA = { x: 0, y: 0, width: 0, height: 0 };
    this._rectB = { x: 0, y: 0, width: 0, height: 0 };
  }

  /**
   * @param {object} owner entity the hitbox follows; needs getPosition()
   *   (or x/y) and isFacingRight() (or numeric facing) for mirroring.
   * @param {object} spec see CONTRACT above
   * @returns {string} hitbox id
   */
  spawnHitbox(owner, spec = {}) {
    if (!owner) throw new Error('[HitboxSystem] spawnHitbox requires an owner');
    if (!(spec.w > 0) || !(spec.h > 0)) {
      throw new Error('[HitboxSystem] spawnHitbox requires positive w/h');
    }
    const duration = spec.duration ?? 0.2;
    const damage = { ...(spec.damage ?? {}) };
    if (spec.type !== undefined && damage.type === undefined) damage.type = spec.type;
    if (spec.knockback !== undefined && damage.knockback === undefined) {
      damage.knockback = spec.knockback;
    }

    const id = spec.id ?? `hb_${nextHitboxId++}`;
    const hb = {
      id,
      owner,
      w: spec.w,
      h: spec.h,
      offsetX: spec.offsetX ?? 0,
      offsetY: spec.offsetY ?? 0,
      duration,
      activeFrom: spec.activeFrom ?? 0,
      activeTo: spec.activeTo ?? duration,
      damage,
      hitOnce: spec.hitOnce !== false,
      hitSet: spec.hitOnce !== false ? new Set() : null,
      source: spec.source ?? {
        id: owner.id ?? 'unknown',
        kind: owner.kind ?? 'enemy',
      },
      elapsed: 0,
    };
    this._hitboxes.set(id, hb);
    return id;
  }

  /** Cancel one hitbox early (attack interrupted). No-op for unknown ids. */
  despawnHitbox(id) {
    this._hitboxes.delete(id);
  }

  /**
   * @param {object} entity must expose id (+ takeDamage/getDefense/
   *   isInvulnerable/getBounds per CONTRACT)
   * @param {{w:number,h:number,offsetX?:number,offsetY?:number}} [box] fallback
   */
  registerHurtbox(entity, box = null) {
    const id = entityIdOf(entity);
    if (!id) throw new Error('[HitboxSystem] registerHurtbox: entity needs an id');
    this._hurtboxes.set(id, { entity, box: box ?? { w: 0, h: 0, offsetX: 0, offsetY: 0 } });
  }

  /** @param {object} entity */
  unregisterHurtbox(entity) {
    const id = entityIdOf(entity);
    if (id) this._hurtboxes.delete(id);
  }

  /** Read accessor for ProjectileSystem — single hurtbox source of truth. */
  forEachHurtbox(fn) {
    for (const rec of this._hurtboxes.values()) fn(rec.entity, rec.box);
  }

  /** @returns {number} live hitboxes (debug overlay) */
  getHitboxCount() {
    return this._hitboxes.size;
  }

  /** @returns {number} registered hurtboxes (debug overlay) */
  getHurtboxCount() {
    return this._hurtboxes.size;
  }

  /** World-space rect of a hitbox, following + mirroring its owner. */
  _placeHitboxRect(hb, out) {
    let px, py;
    if (typeof hb.owner.getPosition === 'function') {
      const p = hb.owner.getPosition();
      px = p.x;
      py = p.y;
    } else {
      px = hb.owner.x ?? 0;
      py = hb.owner.y ?? 0;
    }
    let facing = 1;
    if (typeof hb.owner.isFacingRight === 'function') {
      facing = hb.owner.isFacingRight() ? 1 : -1;
    } else if (typeof hb.owner.facing === 'number') {
      facing = hb.owner.facing >= 0 ? 1 : -1;
    }
    out.width = hb.w;
    out.height = hb.h;
    out.x = px + hb.offsetX * facing - hb.w / 2;
    out.y = py + hb.offsetY - hb.h / 2;
  }

  /** World-space rect of a hurtbox record. */
  _placeHurtboxRect(rec, out) {
    const e = rec.entity;
    if (typeof e.getBounds === 'function') {
      const b = e.getBounds();
      out.x = b.x;
      out.y = b.y;
      out.width = b.width;
      out.height = b.height;
      return;
    }
    // Fallback: entity x/y + registered box (headless / minimal entities).
    const box = rec.box;
    out.width = box.w;
    out.height = box.h;
    out.x = (e.x ?? 0) + (box.offsetX ?? 0) - box.w / 2;
    out.y = (e.y ?? 0) + (box.offsetY ?? 0) - box.h / 2;
  }

  /** Called once per frame by the owning scene. No per-frame allocation. */
  update(dt) {
    if (this._hitboxes.size === 0) return;
    for (const [id, hb] of this._hitboxes) {
      hb.elapsed += dt;
      if (hb.elapsed >= hb.duration) {
        this._hitboxes.delete(id);
        continue;
      }
      // Damage ONLY during the active window.
      if (hb.elapsed < hb.activeFrom || hb.elapsed > hb.activeTo) continue;

      this._placeHitboxRect(hb, this._rectA);

      for (const rec of this._hurtboxes.values()) {
        const target = rec.entity;
        if (target === hb.owner) continue;
        const tid = entityIdOf(target);
        if (hb.hitOnce && hb.hitSet.has(tid)) continue;

        this._placeHurtboxRect(rec, this._rectB);
        if (!aabb(this._rectA, this._rectB)) continue;

        if (hb.hitOnce) hb.hitSet.add(tid);
        DamageSystem.applyDamage(hb.source, target, hb.damage);
      }
    }
  }

  /**
   * Dev visualization (spec §16). Hitboxes: red while in the active window,
   * amber otherwise. Hurtboxes: green.
   * @param {object} graphics duck-typed { lineStyle, strokeRect }
   */
  drawDebug(graphics) {
    if (!graphics) return;
    graphics.lineStyle(1, 0x39d353, 0.9);
    for (const rec of this._hurtboxes.values()) {
      this._placeHurtboxRect(rec, this._rectB);
      graphics.strokeRect(this._rectB.x, this._rectB.y, this._rectB.width, this._rectB.height);
    }
    for (const hb of this._hitboxes.values()) {
      const inWindow = hb.elapsed >= hb.activeFrom && hb.elapsed <= hb.activeTo;
      graphics.lineStyle(1, inWindow ? 0xff3b30 : 0xffd60a, 0.9);
      this._placeHitboxRect(hb, this._rectA);
      graphics.strokeRect(this._rectA.x, this._rectA.y, this._rectA.width, this._rectA.height);
    }
  }

  /** Drop all hitboxes (room teardown). Hurtboxes unregister with entities. */
  clear() {
    this._hitboxes.clear();
  }

  shutdown() {
    this._hitboxes.clear();
    this._hurtboxes.clear();
  }
}
