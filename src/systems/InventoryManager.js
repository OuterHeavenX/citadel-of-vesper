/**
 * InventoryManager — inventory model + consumable use (Wave 4).
 *
 * CONTRACT:
 * - Wraps gameState inventory (the serializable source of truth); every
 *   mutation goes through GameState methods so `inventory:changed` (and
 *   `item:pickedUp` on adds) keep flowing to the UI.
 * - add() respects the data `maxStack` (default: unlimited) and reports
 *   { added, overflow }.
 * - useItem() applies consumable effects from data/consumables.json:
 *     heal / healPercent -> through the Player API when a player instance
 *       is supplied (Player.heal, clamped to the EFFECTIVE max HP and
 *       emitting 'player:healed'); headless fallback uses GameState.setHp
 *       against the stored max HP and emits 'player:healed' itself.
 *     mana / manaPercent -> GameState.setMp.
 *     buff               -> gameState.addBuff() (timed stat buff; PlayerStats
 *       folds active buffs into derived stats; expires on playTime).
 *     cure               -> best-effort removal via an injected statusEffects
 *       instance (target defaults to the player argument).
 * - usableInCombat gates combat use; non-consumables and unknown ids are
 *   rejected with a reason code (never throw — the UI shows the reason).
 *
 * Wave 5 wiring: construct once in GameScene and pass the live Player as
 * the `player` argument to useItem(); call update() nowhere (buff expiry
 * is playTime-driven, pruned lazily).
 */
import { eventBus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { getItemData } from '../items/ItemData.js';

export class InventoryManager {
  /**
   * @param {object} [deps]
   * @param {object} [deps.state] GameState singleton (injectable for tests)
   */
  constructor({ state = gameState } = {}) {
    this.state = state;
    this._items = getItemData();
  }

  /** @param {string} itemId @returns {object} item definition (throws on unknown) */
  describe(itemId) {
    return this._items.get(itemId);
  }

  /**
   * Add items, respecting maxStack.
   * @param {string} itemId @param {number} [quantity=1]
   * @returns {{added:number, overflow:number, reason?:string}}
   */
  add(itemId, quantity = 1) {
    let def;
    try {
      def = this._items.get(itemId);
    } catch {
      return { added: 0, overflow: quantity, reason: 'unknown_item' };
    }
    if (!(quantity > 0)) return { added: 0, overflow: 0, reason: 'invalid_quantity' };
    const maxStack = def.maxStack ?? Infinity;
    const held = this.state.countItem(itemId);
    const room = Math.max(0, maxStack - held);
    const added = Math.min(quantity, room);
    if (added > 0) this.state.addItem(itemId, added);
    return { added, overflow: quantity - added };
  }

  /**
   * @param {string} itemId @param {number} [quantity=1]
   * @returns {boolean} false when fewer than `quantity` are held
   */
  remove(itemId, quantity = 1) {
    if (this.state.countItem(itemId) < quantity) return false;
    return this.state.removeItem(itemId, quantity);
  }

  /** @param {string} itemId @returns {number} */
  count(itemId) {
    return this.state.countItem(itemId);
  }

  /** @returns {{item:object, quantity:number}[]} enriched inventory rows */
  getInventory() {
    return this.state.data.inventory.map((entry) => ({
      item: this._items.get(entry.itemId),
      quantity: entry.quantity,
    }));
  }

  /** @returns {{item:object, quantity:number}[]} usable consumables held */
  getConsumables() {
    return this.getInventory().filter(({ item }) => item.category === 'consumable');
  }

  /** Prune expired buffs against current playTime. @returns {number} removed */
  update() {
    return this.state.pruneBuffs();
  }

  /**
   * Use one unit of a consumable.
   * @param {string} itemId
   * @param {object} [opts]
   * @param {object} [opts.player] Player facade (needs .heal(amount)); when
   *   omitted, healing falls back to GameState against the stored max HP.
   * @param {object} [opts.target] status-effect target for `cure` (defaults to player)
   * @param {object} [opts.statusEffects] StatusEffects instance for `cure`
   * @param {boolean} [opts.inCombat=false]
   * @returns {{ok:boolean, reason?:string, applied?:object}}
   */
  useItem(itemId, { player = null, target = null, statusEffects = null, inCombat = false } = {}) {
    let def;
    try {
      def = this._items.get(itemId);
    } catch {
      return { ok: false, reason: 'unknown_item' };
    }
    if (def.category !== 'consumable') return { ok: false, reason: 'not_consumable' };
    if (this.state.countItem(itemId) < 1) return { ok: false, reason: 'none_held' };
    if (inCombat && !def.usableInCombat) return { ok: false, reason: 'not_usable_in_combat' };

    const effect = def.effect ?? {};
    const applied = {};

    // Consume first so a throwing effect application can't duplicate items.
    this.state.removeItem(itemId, 1);

    try {
      const p = this.state.data.player;
      if (effect.healPercent != null) {
        const maxHp = player && typeof player.heal === 'function' && player.stats
          ? player.stats.getEffectiveMaxHp()
          : p.maxHp;
        const amount = Math.round((maxHp * effect.healPercent) / 100);
        applied.heal = this._applyHeal(amount, player);
      } else if (effect.heal != null) {
        applied.heal = this._applyHeal(effect.heal, player);
      }
      if (effect.manaPercent != null) {
        const amount = Math.round((p.maxMp * effect.manaPercent) / 100);
        this.state.setMp(Math.min(p.maxMp, p.mp + amount));
        applied.mana = amount;
      } else if (effect.mana != null) {
        this.state.setMp(Math.min(p.maxMp, p.mp + effect.mana));
        applied.mana = effect.mana;
      }
      if (effect.buff) {
        const b = effect.buff;
        this.state.addBuff({
          id: b.id,
          name: b.name ?? b.id,
          stats: { ...(b.stats ?? {}) },
          expiresAt: this.state.data.playTime + (b.durationSec ?? 30),
        });
        applied.buff = b.id;
      }
      if (effect.cure) {
        const whom = target ?? player;
        const cured = [];
        for (const effectId of effect.cure) {
          try {
            statusEffects?.remove?.(whom, effectId);
            cured.push(effectId);
          } catch {
            /* best effort */
          }
        }
        applied.cured = cured;
      }
    } catch (err) {
      return { ok: false, reason: 'effect_failed', applied };
    }

    eventBus.emit('inventory:changed', {});
    return { ok: true, applied };
  }

  /**
   * Heal through the Player API when available (effective max HP +
   * 'player:healed'), else through GameState (stored max HP).
   * @private @returns {number} HP actually restored
   */
  _applyHeal(amount, player) {
    if (player && typeof player.heal === 'function') {
      return player.heal(amount);
    }
    const p = this.state.data.player;
    const actual = Math.min(amount, p.maxHp - p.hp);
    if (actual <= 0) return 0;
    this.state.setHp(p.hp + actual);
    const hp = this.state.data.player.hp;
    eventBus.emit('player:healed', { amount: actual, hp, maxHp: p.maxHp });
    return actual;
  }
}

/** Shared singleton (GameScene / UI use this instance). */
export const inventoryManager = new InventoryManager();
