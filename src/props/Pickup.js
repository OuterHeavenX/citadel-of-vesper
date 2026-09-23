/**
 * Pickup — collectible drops (coins, hearts, mana shards, keys, items).
 *
 * CONTRACT:
 * - A pickup is constructed from a REF: 'coin' | 'heart' | 'mana' |
 *   'key' | <itemId>. 'coin'/'heart'/'mana' are currency-like kinds from
 *   PICKUP_KINDS; 'key' needs spec.itemId (the key item); anything else is
 *   treated as an itemId (enemy drops, room pickups, chest rewards).
 * - Magnet: within magnetRadius the pickup accelerates toward the player;
 *   within collectRadius it is collected. Bobbing idle animation otherwise.
 * - On collect, effects route through GameState (never direct mutation):
 *     coin  -> gameState.addCurrency(value)
 *     heart -> heal: setHp(min(maxHp, hp + value)) + 'player:healed'
 *     mana  -> setMp(min(maxMp, mp + value))
 *     key   -> gameState.addItem(itemId) + 'item:pickedUp'
 *     item  -> gameState.addItem(itemId, qty) + 'item:pickedUp'
 *   plus playSfx('pickup_item') and ctx.onCollect?.(pickup).
 * - Static room pickups persist; dropped ones (opts.temporary) despawn
 *   after PICKUP_LIFETIME seconds, blinking for the last 3.
 * - Headless-safe: scene = null skips all Phaser work (tests).
 *
 * RoomManager integration (Wave 3):
 *   // from rooms.json pickups:
 *   new Pickup(scene, p.itemId, p.x, p.y, { gameState, quantity: p.quantity });
 *   // from Enemy/Breakable ctx.spawnPickup(x, y, ref):
 *   new Pickup(scene, ref, x, y, { gameState, temporary: true });
 *   // per frame: pickup.update(dt, { x: player.x, y: player.y })
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { audioManager } from '../core/AudioManager.js';

const MAGNET_RADIUS = 80;
const COLLECT_RADIUS = 14;
const PICKUP_LIFETIME = 25;
const BLINK_AT = 3; // s before expiry when blinking starts

/** kind -> { texture, value, magnet } */
export const PICKUP_KINDS = {
  coin: { texture: 'coin', value: 5, magnet: MAGNET_RADIUS },
  heart: { texture: 'heart', value: 25, magnet: MAGNET_RADIUS },
  mana: { texture: 'mana_shard', value: 20, magnet: MAGNET_RADIUS },
  // 'key' is special: texture 'key', effect adds spec.itemId to inventory.
  key: { texture: 'key', value: 1, magnet: MAGNET_RADIUS },
};

/**
 * Resolve a pickup ref to { kind, itemId?, quantity }.
 * @param {string} ref 'coin'|'heart'|'mana'|'key'|<itemId>
 * @param {object} [spec] { itemId (for 'key'), quantity }
 */
export function resolvePickupRef(ref, spec = {}) {
  if (ref === 'key') {
    if (!spec.itemId) {
      throw new Error("[Pickup] kind 'key' requires spec.itemId (the key item).");
    }
    return { kind: 'key', itemId: spec.itemId, quantity: spec.quantity ?? 1 };
  }
  if (PICKUP_KINDS[ref]) return { kind: ref, itemId: null, quantity: spec.quantity ?? 1 };
  return { kind: 'item', itemId: ref, quantity: spec.quantity ?? 1 };
}

export class Pickup {
  /**
   * @param {Phaser.Scene|null} scene null => headless
   * @param {string} ref pickup ref (see resolvePickupRef)
   * @param {number} x @param {number} y
   * @param {object} [ctx] { gameState, playSfx, onCollect, temporary, itemId, quantity, value }
   */
  constructor(scene, ref, x, y, ctx = {}) {
    const resolved = resolvePickupRef(ref, ctx);
    this.scene = scene;
    this.ref = ref;
    this.kind = resolved.kind;
    this.itemId = resolved.itemId;
    this.quantity = resolved.quantity;
    const kindDef = PICKUP_KINDS[this.kind];
    this.texture = kindDef?.texture ?? this.itemId; // item icons key 1:1 with texture
    this.value = ctx.value ?? kindDef?.value ?? 0;
    this.x = x;
    this.y = y;
    this.baseY = y;
    this.vx = (Math.random() - 0.5) * 40; // scatter pop (visual only)
    this.vy = -60;
    this.bobT = Math.random() * Math.PI * 2;
    this.collected = false;
    this.destroyed = false;
    this.temporary = ctx.temporary ?? false;
    this.life = PICKUP_LIFETIME;
    this.ctx = {
      gameState: ctx.gameState ?? gameState,
      playSfx: ctx.playSfx ?? ((id, opts) => audioManager.playSfx(id, opts)),
      onCollect: ctx.onCollect ?? null,
    };
    this.sprite = null;
    if (scene && scene.add) {
      try {
        const hasTex = scene.textures?.exists(this.texture);
        this.sprite = scene.add.sprite(x, y, hasTex ? this.texture : undefined);
        this.sprite.setOrigin(0.5, 0.5);
        this.sprite.setDepth(6);
      } catch {
        this.sprite = null;
      }
    }
  }

  /**
   * @param {number} dt seconds
   * @param {object|null} playerPos { x, y }
   */
  update(dt, playerPos = null) {
    if (this.collected || this.destroyed) return;
    if (this.temporary) {
      this.life -= dt;
      if (this.life <= 0) {
        this.destroy();
        return;
      }
      if (this.sprite && this.life < BLINK_AT) {
        try {
          this.sprite.setAlpha(Math.sin(this.life * 18) > 0 ? 1 : 0.25);
        } catch {
          /* ignore */
        }
      }
    }
    this.bobT += dt * 4;
    if (playerPos) {
      const dx = playerPos.x - this.x;
      const dy = playerPos.y - 8 - this.y;
      const d = Math.hypot(dx, dy);
      const magnetR = PICKUP_KINDS[this.kind]?.magnet ?? MAGNET_RADIUS;
      if (d < COLLECT_RADIUS) {
        this.collect();
        return;
      }
      if (d < magnetR && d > 1) {
        // magnet: accelerate toward the player
        const pull = 900;
        this.vx += (dx / d) * pull * dt;
        this.vy += (dy / d) * pull * dt;
      } else {
        this.vx *= 1 - Math.min(1, dt * 5);
        this.vy *= 1 - Math.min(1, dt * 5);
      }
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const bobY = Math.sin(this.bobT) * 3;
    if (this.sprite) {
      try {
        this.sprite.setPosition(this.x, this.y + bobY);
      } catch {
        /* ignore */
      }
    }
  }

  /** Apply the pickup effect through GameState. Idempotent. */
  collect() {
    if (this.collected || this.destroyed) return;
    this.collected = true;
    const gs = this.ctx.gameState;
    try {
      switch (this.kind) {
        case 'coin':
          gs.addCurrency(this.value);
          break;
        case 'heart': {
          const hp = gs.data.player.hp;
          const maxHp = gs.data.player.maxHp;
          const healed = Math.min(maxHp, hp + this.value);
          gs.setHp(healed);
          eventBus.emit('player:healed', { amount: healed - hp, hp: healed, maxHp });
          break;
        }
        case 'mana': {
          const mp = gs.data.player.mp;
          gs.setMp(Math.min(gs.data.player.maxMp, mp + this.value));
          break;
        }
        case 'key':
        case 'item':
          gs.addItem(this.itemId, this.quantity); // emits 'item:pickedUp' once
          break;
      }
      // W5-AUDIO: kind-specific pickup voice — coin/heart/mana have their
      // own registry recipes; keys and items fall back to the generic one.
      // No channel override: the definitions carry the right channel
      // ('player' for pickups, 'ui' for the generic).
      const sfxId =
        this.kind === 'coin' ? 'coin'
        : this.kind === 'heart' ? 'heart'
        : this.kind === 'mana' ? 'mana'
        : 'pickup_item';
      this.ctx.playSfx(sfxId, { x: this.x, y: this.y });
    } catch {
      /* collection must never throw */
    }
    if (typeof this.ctx.onCollect === 'function') {
      try {
        this.ctx.onCollect(this);
      } catch {
        /* ignore */
      }
    }
    this.destroy();
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
