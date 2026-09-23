/**
 * EquipmentManager tests — slot resolution, equip/unequip round-trips,
 * real stat derivation through PlayerStats, and equipped-vs-candidate compare.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EquipmentManager } from '../src/systems/EquipmentManager.js';
import { PlayerStats } from '../src/player/PlayerStats.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';

describe('EquipmentManager', () => {
  let eq;
  let stats;
  let seen;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    eq = new EquipmentManager();
    stats = new PlayerStats();
    seen = { equipped: [], unequipped: [] };
    eventBus.on('item:equipped', (p) => seen.equipped.push(p));
    eventBus.on('item:unequipped', (p) => seen.unequipped.push(p));
  });
  afterEach(() => {
    stats.destroy();
    eventBus.clear();
    gameState.reset();
  });

  it('resolves slots by category (weapons have no slot field in data)', () => {
    expect(eq.resolveSlot('recruit_blade')).toBe('weapon');
    expect(eq.resolveSlot('moonsteel_sabre')).toBe('weapon');
    expect(eq.resolveSlot('wayfarer_coat')).toBe('body');
    expect(eq.resolveSlot('dusk_hood')).toBe('head');
    expect(eq.resolveSlot('ember_tonic')).toBeNull();
    expect(eq.resolveSlot('no_such_item')).toBeNull();
  });

  it('accessories fill accessory1 then accessory2', () => {
    expect(eq.resolveSlot('moonstone_charm')).toBe('accessory1');
    gameState.addItem('moonstone_charm', 1);
    expect(eq.equip('moonstone_charm').slot).toBe('accessory1');
    gameState.addItem('iron_signet', 1);
    expect(eq.equip('iron_signet').slot).toBe('accessory2');
    expect(eq.resolveSlot('iron_signet')).toBe('accessory1'); // both full -> first
  });

  it('equip moves the item out of inventory and returns the previous one', () => {
    gameState.addItem('recruit_blade', 1);
    gameState.addItem('moonsteel_sabre', 1);
    const r1 = eq.equip('recruit_blade');
    expect(r1).toEqual({ ok: true, slot: 'weapon', previous: null });
    expect(gameState.data.equipment.weapon).toBe('recruit_blade');
    expect(gameState.countItem('recruit_blade')).toBe(0);
    expect(seen.equipped).toEqual([{ itemId: 'recruit_blade', slot: 'weapon' }]);

    const r2 = eq.equip('moonsteel_sabre');
    expect(r2).toEqual({ ok: true, slot: 'weapon', previous: 'recruit_blade' });
    expect(gameState.countItem('recruit_blade')).toBe(1); // old blade back in bag
  });

  it('equip rejects unknown, non-equippable, and unheld items', () => {
    expect(eq.equip('no_such_item').reason).toBe('unknown_item');
    expect(eq.equip('ember_tonic').reason).toBe('not_equippable');
    expect(eq.equip('recruit_blade').reason).toBe('not_in_inventory');
  });

  it('unequip returns the item to inventory', () => {
    gameState.addItem('dusk_hood', 1);
    eq.equip('dusk_hood');
    const r = eq.unequip('head');
    expect(r).toEqual({ ok: true, itemId: 'dusk_hood' });
    expect(gameState.data.equipment.head).toBeNull();
    expect(gameState.countItem('dusk_hood')).toBe(1);
    expect(seen.unequipped).toEqual([{ slot: 'head' }]);
    expect(eq.unequip('head').reason).toBe('slot_empty');
    expect(eq.unequip('nope').reason).toBe('unknown_slot');
  });

  it('equipped weapons really change derived physicalAttack', () => {
    const bare = stats.getDerived().physicalAttack; // round(8 * 1.2) = 10
    expect(bare).toBe(10);
    gameState.addItem('recruit_blade', 1);
    eq.equip('recruit_blade'); // atk 8 -> round(9.6 + 8) = 18
    expect(stats.getDerived().physicalAttack).toBe(18);
    gameState.addItem('moonsteel_sabre', 1);
    eq.equip('moonsteel_sabre'); // atk 34, str 2 -> round(10 * 1.2 + 34) = 46
    expect(stats.getDerived().physicalAttack).toBe(46);
  });

  it('armor stats and resistances flow into derived stats', () => {
    gameState.addItem('wayfarer_coat', 1);
    eq.equip('wayfarer_coat'); // def 6, hp 10
    expect(stats.getDerived().defense).toBe(Math.round(8 * 0.8 + 6));
    expect(stats.getEffectiveMaxHp()).toBe(60 + 10);
    gameState.addItem('dusk_hood', 1);
    eq.equip('dusk_hood'); // resistances.shadow 0.1
    expect(stats.getDerived().resistances.shadow).toBeCloseTo(0.1, 5);
    expect(stats.getDefense('shadow')).toBeGreaterThan(stats.getDefense('fire'));
  });

  it('compareToEquipped uses WeaponData.compare for weapons', () => {
    gameState.addItem('recruit_blade', 1);
    eq.equip('recruit_blade');
    const cmp = eq.compareToEquipped('moonsteel_sabre');
    expect(cmp.ok).toBe(true);
    expect(cmp.slot).toBe('weapon');
    expect(cmp.equippedId).toBe('recruit_blade');
    expect(cmp.atkDelta).toBe(26); // 34 - 8
    expect(cmp.critDelta).toBe(4);
    expect(cmp.speedDelta).toBeCloseTo(0.25, 5);
    expect(cmp.statDeltas).toEqual({ str: 2 });
  });

  it('compareToEquipped returns raw deltas for armor vs empty slot', () => {
    const cmp = eq.compareToEquipped('wayfarer_coat');
    expect(cmp.ok).toBe(true);
    expect(cmp.slot).toBe('body');
    expect(cmp.equippedId).toBeNull();
    expect(cmp.statDeltas).toEqual({ def: 6, hp: 10 });
  });
});
