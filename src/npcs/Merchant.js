/**
 * Merchant — buy/sell/compare shop (Wave 4; spec §48).
 *
 * CONTRACT:
 * - Stock is data-driven (data/merchants.json): base lines + `requiresFlag`
 *   unlocks (e.g. boss_defeated_chapel_warden) + finite `quantity` lines.
 *   Finite stock decrements persist in gameState.merchantStock (serializable;
 *   survives saves).
 * - buy(itemId): currency via GameState.spendCurrency(); the item lands via
 *   GameState.addItem() (-> `item:pickedUp` + `inventory:changed`).
 * - sell(itemId): price = floor(value * tuning.economy.sellRate); soulbound
 *   categories (quest/relic/key) and currently-equipped items are refused.
 * - compare(itemId): delegates to EquipmentManager.compareToEquipped() —
 *   the EQUIPPED-vs-candidate view (spec §19).
 * - Prices: round(value * merchant.priceMult * line.priceMult), never below
 *   tuning.economy.minBuyPrice.
 * - Headless-safe (no Phaser). All failure modes return { ok:false, reason }
 *   so the shop UI can show the reason instead of crashing.
 *
 * Wave 5 wiring: the shop UI constructs `new Merchant(merchantId)` and calls
 * getStock()/buy()/sell()/compare(); no scene changes needed.
 */
import { gameState } from '../core/GameState.js';
import { dataManager } from '../core/DataManager.js';
import { getItemData } from '../items/ItemData.js';
import { tuning } from '../config/tuning.js';
import { EquipmentManager } from '../systems/EquipmentManager.js';

/** Categories that are never sold (quest items, relics, keys). */
const SOULBOUND_CATEGORIES = new Set(['quest', 'relic', 'key']);

export class Merchant {
  /**
   * @param {string} merchantId id in data/merchants.json
   * @param {object} [deps]
   * @param {object} [deps.state] GameState singleton (injectable for tests)
   */
  constructor(merchantId, { state = gameState } = {}) {
    const def = dataManager.getData('merchants').find((m) => m.id === merchantId);
    if (!def) throw new Error(`unknown merchant id '${merchantId}'`);
    this.id = merchantId;
    this.def = def;
    this.state = state;
    this._items = getItemData();
    this._equipment = new EquipmentManager({ state });
  }

  /** @returns {string} display name */
  get name() {
    return this.def.name;
  }

  /**
   * Buy price for a stock line.
   * @param {object} line stock line
   * @returns {number}
   */
  buyPrice(line) {
    const item = this._items.get(line.itemId);
    const raw = item.value * (this.def.priceMult ?? 1) * (line.priceMult ?? 1);
    return Math.max(tuning.economy.minBuyPrice, Math.round(raw));
  }

  /**
   * Sell price for an item id.
   * @param {string} itemId @returns {number}
   */
  sellPrice(itemId) {
    const item = this._items.get(itemId);
    return Math.floor(item.value * tuning.economy.sellRate);
  }

  /**
   * Current stock with dynamic unlocks and remaining quantities applied.
   * @returns {{itemId:string, item:object, price:number, quantity:number|null,
   *   locked:boolean}[]} quantity null = unlimited
   */
  getStock() {
    return this.def.stock.map((line) => {
      const locked = line.requiresFlag ? !this.state.getFlag(line.requiresFlag) : false;
      let quantity = null;
      if (line.quantity != null) {
        const tracked = this.state.getMerchantStock(this.id, line.itemId);
        quantity = tracked ?? line.quantity;
      }
      return {
        itemId: line.itemId,
        item: this._items.get(line.itemId),
        price: this.buyPrice(line),
        quantity,
        locked,
      };
    });
  }

  /**
   * Buy one unit of a stock line.
   * @param {string} itemId
   * @returns {{ok:boolean, reason?:string, price?:number}}
   */
  buy(itemId) {
    const line = this.def.stock.find((l) => l.itemId === itemId);
    if (!line) return { ok: false, reason: 'not_in_stock' };
    if (line.requiresFlag && !this.state.getFlag(line.requiresFlag)) {
      return { ok: false, reason: 'locked' };
    }
    if (line.quantity != null) {
      const remaining = this.state.getMerchantStock(this.id, itemId) ?? line.quantity;
      if (remaining <= 0) return { ok: false, reason: 'sold_out' };
    }
    const price = this.buyPrice(line);
    if (!this.state.spendCurrency(price)) return { ok: false, reason: 'insufficient_funds' };
    this.state.addItem(itemId, 1);
    if (line.quantity != null) {
      const remaining = (this.state.getMerchantStock(this.id, itemId) ?? line.quantity) - 1;
      this.state.setMerchantStock(this.id, itemId, remaining);
    }
    return { ok: true, price };
  }

  /**
   * Sell one unit from inventory.
   * @param {string} itemId
   * @returns {{ok:boolean, reason?:string, price?:number}}
   */
  sell(itemId) {
    let item;
    try {
      item = this._items.get(itemId);
    } catch {
      return { ok: false, reason: 'unknown_item' };
    }
    if (SOULBOUND_CATEGORIES.has(item.category)) return { ok: false, reason: 'soulbound' };
    const equipped = Object.values(this.state.data.equipment ?? {}).includes(itemId);
    if (equipped) return { ok: false, reason: 'equipped' };
    if (this.state.countItem(itemId) < 1) return { ok: false, reason: 'none_held' };
    const price = this.sellPrice(itemId);
    this.state.removeItem(itemId, 1);
    this.state.addCurrency(price);
    return { ok: true, price };
  }

  /**
   * EQUIPPED-vs-candidate comparison for the shop UI (spec §19).
   * @param {string} itemId @returns {object} EquipmentManager.compareToEquipped result
   */
  compare(itemId) {
    return this._equipment.compareToEquipped(itemId);
  }
}
