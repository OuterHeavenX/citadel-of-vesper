/**
 * InventoryManager tests — add/remove/stack caps, consumable use
 * (heal via the Player API + headless fallback, mana, buffs), combat gating.
 * Real GameState singleton, real EventBus, bundled data/*.json.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { InventoryManager } from '../src/systems/InventoryManager.js';
import { PlayerStats } from '../src/player/PlayerStats.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';

describe('InventoryManager', () => {
  let inv;
  let seen;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    inv = new InventoryManager();
    seen = { inventoryChanged: 0, healed: [] };
    eventBus.on('inventory:changed', () => seen.inventoryChanged++);
    eventBus.on('player:healed', (p) => seen.healed.push(p));
  });
  afterEach(() => {
    eventBus.clear();
    gameState.reset();
  });

  it('adds items and reports stack-capped overflow', () => {
    const r1 = inv.add('ember_tonic', 3);
    expect(r1).toEqual({ added: 3, overflow: 0 });
    expect(inv.count('ember_tonic')).toBe(3);
    // ember_tonic maxStack is 9: adding 20 fills to 9, overflows 14.
    const r2 = inv.add('ember_tonic', 20);
    expect(r2).toEqual({ added: 6, overflow: 14 });
    expect(inv.count('ember_tonic')).toBe(9);
    expect(seen.inventoryChanged).toBeGreaterThan(0);
  });

  it('rejects unknown items and bad quantities', () => {
    expect(inv.add('no_such_item', 1)).toMatchObject({ added: 0, reason: 'unknown_item' });
    expect(inv.add('ember_tonic', 0)).toMatchObject({ added: 0, reason: 'invalid_quantity' });
  });

  it('removes only what is held', () => {
    inv.add('ember_tonic', 2);
    expect(inv.remove('ember_tonic', 1)).toBe(true);
    expect(inv.count('ember_tonic')).toBe(1);
    expect(inv.remove('ember_tonic', 5)).toBe(false);
    expect(inv.count('ember_tonic')).toBe(1);
    expect(inv.remove('vesper_draught', 1)).toBe(false);
  });

  it('getInventory enriches rows with item definitions', () => {
    inv.add('ember_tonic', 2);
    const rows = inv.getInventory();
    expect(rows).toHaveLength(1);
    expect(rows[0].item.name).toBe('Ember Tonic');
    expect(rows[0].quantity).toBe(2);
    expect(inv.getConsumables()).toHaveLength(1);
  });

  it('useItem heals through the Player API when a player is supplied', () => {
    inv.add('ember_tonic', 2);
    const calls = [];
    const fakePlayer = {
      heal: (amount) => { calls.push(amount); return Math.min(amount, 20); },
      stats: { getEffectiveMaxHp: () => 80 },
    };
    const res = inv.useItem('ember_tonic', { player: fakePlayer });
    expect(res.ok).toBe(true);
    expect(res.applied).toMatchObject({ heal: 20 });
    expect(calls).toEqual([50]); // ember_tonic heals 50
    expect(inv.count('ember_tonic')).toBe(1); // one unit consumed
  });

  it('useItem heals via GameState fallback and emits player:healed once', () => {
    inv.add('ember_tonic', 1);
    gameState.setHp(10);
    const res = inv.useItem('ember_tonic'); // no player -> headless fallback
    expect(res.ok).toBe(true);
    expect(res.applied).toMatchObject({ heal: 50 });
    expect(gameState.data.player.hp).toBe(60); // clamped to stored maxHp
    expect(seen.healed).toHaveLength(1);
    expect(seen.healed[0]).toMatchObject({ amount: 50, hp: 60, maxHp: 60 });
  });

  it('useItem restores mana and applies buffs that reach derived stats', () => {
    const stats = new PlayerStats();
    try {
      inv.add('vesper_draught', 1);
      gameState.setMp(0);
      const mana = inv.useItem('vesper_draught');
      expect(mana.ok).toBe(true);
      expect(mana.applied).toMatchObject({ mana: 30 });
      expect(gameState.data.player.mp).toBe(20); // clamped to stored maxMp

      const before = stats.getDerived().defense;
      inv.add('ashward_draught', 1);
      const buff = inv.useItem('ashward_draught');
      expect(buff.ok).toBe(true);
      expect(buff.applied).toMatchObject({ buff: 'ash_ward' });
      const entry = gameState.data.buffs.find((b) => b.id === 'ash_ward');
      expect(entry).toBeDefined();
      expect(entry.expiresAt).toBe(gameState.data.playTime + 60);
      // ash_ward grants +12 def; PlayerStats recalcs on inventory:changed.
      expect(stats.getDerived().defense).toBe(before + 12);
    } finally {
      stats.destroy();
    }
  });

  it('expired buffs stop contributing after prune', () => {
    const stats = new PlayerStats();
    try {
      inv.add('ashward_draught', 1);
      const before = stats.getDerived().defense;
      inv.useItem('ashward_draught');
      expect(stats.getDerived().defense).toBe(before + 12);
      gameState.setPlayTime(gameState.data.playTime + 61);
      expect(inv.update()).toBe(1); // one buff pruned
      // pruneBuffs emits inventory:changed -> PlayerStats recalcs.
      expect(stats.getDerived().defense).toBe(before);
    } finally {
      stats.destroy();
    }
  });

  it('useItem rejects non-consumables, missing stock, and combat misuse', () => {
    expect(inv.useItem('recruit_blade').reason).toBe('not_consumable');
    expect(inv.useItem('ember_tonic').reason).toBe('none_held');
    expect(inv.useItem('no_such_item').reason).toBe('unknown_item');
    inv.add('waybread', 1); // usableInCombat: false
    const res = inv.useItem('waybread', { inCombat: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_usable_in_combat');
    expect(inv.count('waybread')).toBe(1); // not consumed on rejection
    const ok = inv.useItem('waybread', { inCombat: false });
    expect(ok.ok).toBe(true);
  });

  it('useItem cure path is best-effort through an injected statusEffects', () => {
    const removed = [];
    const statusEffects = { remove: (target, id) => removed.push([target, id]) };
    inv.add('ember_tonic', 1);
    const res = inv.useItem('ember_tonic', { target: 'player-entity', statusEffects });
    expect(res.ok).toBe(true);
    expect(removed).toEqual([]); // ember_tonic has no cure list
  });
});
