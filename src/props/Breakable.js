/**
 * Breakable — smashable room props (candles, urns, crates, chandeliers).
 *
 * CONTRACT:
 * - Data-light: BREAKABLE_DEFS below is the whole table (kind -> hp,
 *   texture key, drop table). Room data references kinds via
 *   rooms.json `breakables: [{ kind, x, y }]` (see room.schema.json).
 * - hp is 1 for every breakable: one solid hit destroys it.
 * - On destroy: playSfx('shatter') on the environment channel, roll the
 *   drop table, spawn pickups via ctx.spawnPickup(x, y, pickupRef), call
 *   ctx.onBroken?.(breakable). Emits NO events (per Wave 2 spec) — the
 *   pickup collection effects are what the rest of the game observes.
 * - Headless-safe: scene = null skips all Phaser work (tests).
 *
 * Combat wiring (Wave 3 / RoomManager): register the breakable as a
 * hurtbox with HitboxSystem and route hits to breakable.hit(). Player
 * attacks already flow through HitboxSystem; breakables are NOT
 * DamageSystem targets (they have no defenses, no HP economy).
 */
import { audioManager } from '../core/AudioManager.js';

/**
 * kind -> { hp, texture, drops: [{ pickup, chance, n }] }
 * `pickup` is a Pickup ref: 'coin' | 'heart' | 'mana' | itemId.
 */
export const BREAKABLE_DEFS = {
  candle: {
    hp: 1,
    texture: 'candle',
    drops: [{ pickup: 'coin', chance: 0.35, n: 1 }],
  },
  urn: {
    hp: 1,
    texture: 'urn',
    drops: [
      { pickup: 'coin', chance: 0.6, n: 2 },
      { pickup: 'heart', chance: 0.25, n: 1 },
    ],
  },
  crate: {
    hp: 1,
    texture: 'crate',
    drops: [
      { pickup: 'coin', chance: 0.5, n: 1 },
      { pickup: 'heart', chance: 0.15, n: 1 },
    ],
  },
  chandelier: {
    hp: 1,
    texture: 'chandelier',
    drops: [{ pickup: 'coin', chance: 0.8, n: 3 }],
  },
};

export class Breakable {
  /**
   * @param {Phaser.Scene|null} scene null => headless
   * @param {'candle'|'urn'|'crate'|'chandelier'} kind
   * @param {number} x @param {number} y feet position
   * @param {object} [ctx] { rng, playSfx, spawnPickup, onBroken }
   */
  constructor(scene, kind, x, y, ctx = {}) {
    const def = BREAKABLE_DEFS[kind];
    if (!def) {
      throw new Error(
        `[Breakable] unknown kind '${kind}'. Known: ${Object.keys(BREAKABLE_DEFS).join(', ')}.`,
      );
    }
    this.scene = scene;
    this.kind = kind;
    this.def = def;
    this.x = x;
    this.y = y;
    this.hp = def.hp;
    this.broken = false;
    this.destroyed = false;
    this.ctx = {
      rng: ctx.rng ?? Math.random,
      playSfx: ctx.playSfx ?? ((id, opts) => audioManager.playSfx(id, opts)),
      spawnPickup: ctx.spawnPickup ?? (() => {}),
      onBroken: ctx.onBroken ?? null,
    };
    this.sprite = null;
    if (scene && scene.add) {
      try {
        const hasTex = scene.textures?.exists(def.texture);
        this.sprite = scene.add.sprite(x, y, hasTex ? def.texture : undefined);
        this.sprite.setOrigin(0.5, 1);
        this.sprite.setDepth(5);
        // Wave 5: play the prop's flicker anim when one is registered
        // (candle / brazier / torch_wall / teleport_dais).
        try {
          if (hasTex && scene.anims?.exists(def.texture)) this.sprite.play(def.texture);
        } catch { /* static prop */ }
      } catch {
        this.sprite = null;
      }
    }
  }

  /** A hit landed — one hit is enough (hp 1). @returns {boolean} broke now */
  hit() {
    if (this.broken || this.destroyed) return false;
    this.hp -= 1;
    if (this.hp <= 0) {
      this._break();
      return true;
    }
    return false;
  }

  _break() {
    this.broken = true;
    try {
      this.ctx.playSfx('shatter', { channel: 'environment', x: this.x, y: this.y });
    } catch {
      /* audio is best-effort */
    }
    const rng = this.ctx.rng;
    this.def.drops.forEach((d, i) => {
      if (rng() < d.chance) {
        for (let n = 0; n < d.n; n++) {
          const spread = (rng() - 0.5) * 26;
          try {
            this.ctx.spawnPickup(this.x + spread, this.y - 14, d.pickup);
          } catch {
            /* ignore */
          }
        }
      }
      void i;
    });
    if (typeof this.ctx.onBroken === 'function') {
      try {
        this.ctx.onBroken(this);
      } catch {
        /* ignore */
      }
    }
    // shatter visual: quick scale-pop + fade, then release
    const s = this.sprite;
    if (s && this.scene) {
      try {
        if (this.scene.tweens) {
          this.scene.tweens.add({
            targets: s,
            alpha: 0,
            scaleX: 1.3,
            scaleY: 0.6,
            duration: 220,
            onComplete: () => {
              try {
                s.destroy();
              } catch {
                /* ignore */
              }
            },
          });
        } else {
          s.destroy();
        }
      } catch {
        /* ignore */
      }
      this.sprite = null;
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.sprite) {
      try {
        this.sprite.destroy();
      } catch {
        /* ignore */
      }
      this.sprite = null;
    }
  }
}
