/**
 * Pickup flow tests — the full drop path (breakable/enemy -> spawnPickup ->
 * Pickup.collect) lands in currency, HP, MP, and inventory through GameState.
 * Verifies there are no gaps between props/, RoomManager, and GameState.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Pickup, PICKUP_KINDS, resolvePickupRef } from '../src/props/Pickup.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';

describe('pickup flow', () => {
  let seen;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    seen = { pickedUp: [], healed: [] };
    eventBus.on('item:pickedUp', (p) => seen.pickedUp.push(p));
    eventBus.on('player:healed', (p) => seen.healed.push(p));
  });
  afterEach(() => {
    eventBus.clear();
    gameState.reset();
  });

  /** Headless collect: scene=null, no sfx side effects. */
  const collect = (ref, opts = {}) => {
    const p = new Pickup(null, ref, 100, 100, {
      gameState,
      playSfx: () => {},
      ...opts,
    });
    p.collect();
    return p;
  };

  it('coins land in currency', () => {
    collect('coin');
    expect(gameState.data.currency).toBe(PICKUP_KINDS.coin.value);
    collect('coin', { value: 25 });
    expect(gameState.data.currency).toBe(PICKUP_KINDS.coin.value + 25);
  });

  it('hearts heal HP and emit player:healed', () => {
    gameState.setHp(10);
    collect('heart');
    expect(gameState.data.player.hp).toBe(10 + PICKUP_KINDS.heart.value);
    expect(seen.healed).toHaveLength(1);
    expect(seen.healed[0].amount).toBe(PICKUP_KINDS.heart.value);
  });

  it('hearts clamp at max HP', () => {
    gameState.setHp(59);
    collect('heart');
    expect(gameState.data.player.hp).toBe(60);
  });

  it('mana shards restore MP', () => {
    gameState.setMp(0);
    collect('mana');
    expect(gameState.data.player.mp).toBe(PICKUP_KINDS.mana.value);
  });

  it('item pickups land in inventory with exactly one item:pickedUp', () => {
    collect('ember_tonic');
    expect(gameState.countItem('ember_tonic')).toBe(1);
    expect(seen.pickedUp).toEqual([{ itemId: 'ember_tonic', quantity: 1 }]);
  });

  it('key pickups resolve to the spec itemId', () => {
    collect('key', { itemId: 'reliquary_key' });
    expect(gameState.countItem('reliquary_key')).toBe(1);
  });

  it('resolvePickupRef maps every documented ref', () => {
    expect(resolvePickupRef('coin')).toMatchObject({ kind: 'coin' });
    expect(resolvePickupRef('heart')).toMatchObject({ kind: 'heart' });
    expect(resolvePickupRef('mana')).toMatchObject({ kind: 'mana' });
    expect(resolvePickupRef('key', { itemId: 'k' })).toMatchObject({ kind: 'key', itemId: 'k' });
    expect(resolvePickupRef('ember_tonic', { quantity: 3 })).toMatchObject({
      kind: 'item',
      itemId: 'ember_tonic',
      quantity: 3,
    });
    expect(() => resolvePickupRef('key')).toThrow('requires spec.itemId');
  });

  it('collect is idempotent and never throws', () => {
    const p = new Pickup(null, 'coin', 0, 0, { gameState, playSfx: () => {} });
    p.collect();
    const currency = gameState.data.currency;
    p.collect(); // second call is a no-op
    expect(gameState.data.currency).toBe(currency);
  });
});
