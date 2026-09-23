/**
 * Merchant tests — data-driven stock, buy/sell edge cases (insufficient
 * funds, sold-out finite lines, locked flag-gated lines), price modifiers,
 * sell rate from tuning, and persistence of finite stock in gameState.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Merchant } from '../src/npcs/Merchant.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';

describe('Merchant', () => {
  let wren;
  let corvus;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    wren = new Merchant('wren_aldervale');
    corvus = new Merchant('corvus_vane');
  });
  afterEach(() => {
    eventBus.clear();
    gameState.reset();
  });

  it('throws on unknown merchant id', () => {
    expect(() => new Merchant('no_such_merchant')).toThrow("unknown merchant id 'no_such_merchant'");
  });

  it('exposes stock with prices, quantities, and flag-gated locks', () => {
    const stock = wren.getStock();
    expect(stock).toHaveLength(7);
    const tonic = stock.find((s) => s.itemId === 'ember_tonic');
    expect(tonic.price).toBe(30); // value 30 x priceMult 1.0
    expect(tonic.quantity).toBeNull(); // unlimited
    expect(tonic.locked).toBe(false);
    const sabre = stock.find((s) => s.itemId === 'moonsteel_sabre');
    expect(sabre.locked).toBe(true); // requires boss_defeated_chapel_warden
    expect(sabre.quantity).toBe(1);
  });

  it('applies the merchant price modifier (peddler markup)', () => {
    const tonic = corvus.getStock().find((s) => s.itemId === 'ember_tonic');
    expect(tonic.price).toBe(35); // round(30 x 1.15)
  });

  it('buy deducts currency and lands the item in inventory', () => {
    gameState.addCurrency(100);
    const res = wren.buy('ember_tonic');
    expect(res).toEqual({ ok: true, price: 30 });
    expect(gameState.data.currency).toBe(70);
    expect(gameState.countItem('ember_tonic')).toBe(1);
  });

  it('buy fails cleanly on insufficient funds', () => {
    gameState.addCurrency(10);
    const res = wren.buy('ember_tonic');
    expect(res).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(gameState.data.currency).toBe(10);
    expect(gameState.countItem('ember_tonic')).toBe(0);
  });

  it('buy rejects locked and sold-out lines and unknown stock', () => {
    gameState.addCurrency(5000);
    expect(wren.buy('moonsteel_sabre')).toMatchObject({ reason: 'locked' });
    expect(wren.buy('no_such_item')).toMatchObject({ reason: 'not_in_stock' });

    gameState.setFlag('boss_defeated_chapel_warden', true);
    const first = wren.buy('moonsteel_sabre');
    expect(first.ok).toBe(true);
    expect(gameState.getMerchantStock('wren_aldervale', 'moonsteel_sabre')).toBe(0);
    const again = wren.buy('moonsteel_sabre');
    expect(again).toEqual({ ok: false, reason: 'sold_out' });
    // Stock depletion is serializable: it survives a save round-trip.
    const json = gameState.toJSON();
    expect(json.merchantStock.wren_aldervale.moonsteel_sabre).toBe(0);
  });

  it('finite stock unlocks show up once the flag is set', () => {
    gameState.setFlag('boss_defeated_chapel_warden', true);
    const sabre = wren.getStock().find((s) => s.itemId === 'moonsteel_sabre');
    expect(sabre.locked).toBe(false);
    const charm = corvus.getStock().find((s) => s.itemId === 'moonstone_charm');
    expect(charm.locked).toBe(false);
  });

  it('sell pays tuning.economy.sellRate and refuses equipped/soulbound', () => {
    gameState.addItem('ember_tonic', 2);
    const res = corvus.sell('ember_tonic');
    expect(res).toEqual({ ok: true, price: 15 }); // floor(30 x 0.5)
    expect(gameState.data.currency).toBe(15);
    expect(gameState.countItem('ember_tonic')).toBe(1);

    expect(corvus.sell('no_such_item')).toMatchObject({ reason: 'unknown_item' });
    gameState.addItem('recruit_blade', 1);
    gameState.equip('weapon', 'recruit_blade');
    expect(corvus.sell('recruit_blade')).toMatchObject({ reason: 'equipped' });
  });

  it('compare delegates to the equipped-vs-candidate view', () => {
    gameState.addItem('recruit_blade', 1);
    gameState.equip('weapon', 'recruit_blade');
    const cmp = wren.compare('moonsteel_sabre');
    expect(cmp.ok).toBe(true);
    expect(cmp.atkDelta).toBe(26);
  });
});
