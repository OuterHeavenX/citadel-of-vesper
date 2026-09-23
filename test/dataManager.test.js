/**
 * DataManager tests — bundled JSON access + light validation.
 */
import { describe, expect, it } from 'vitest';
import { DataManager, DATASET_NAMES, dataManager } from '../src/core/DataManager.js';

describe('DataManager', () => {
  it('exposes a singleton', () => {
    expect(dataManager).toBeInstanceOf(DataManager);
  });

  it('knows all eleven datasets', () => {
    expect([...DATASET_NAMES].sort()).toEqual(
      ['abilities', 'accessories', 'armor', 'bosses', 'consumables', 'enemies', 'merchants', 'npcs', 'progression', 'rooms', 'weapons'].sort()
    );
  });

  it('getData returns array datasets with string ids', () => {
    for (const name of DATASET_NAMES) {
      if (name === 'progression') continue;
      const data = dataManager.getData(name);
      expect(Array.isArray(data), name).toBe(true);
      expect(data.length, name).toBeGreaterThan(0);
      for (const item of data) expect(typeof item.id, `${name} entry`).toBe('string');
    }
  });

  it('getData returns the progression object with required fields', () => {
    const p = dataManager.getData('progression');
    expect(typeof p.levelCap).toBe('number');
    expect(typeof p.statGrowth).toBe('object');
    expect(typeof p.xpCurve).toBe('object');
  });

  it('getData throws on unknown dataset', () => {
    expect(() => dataManager.getData('bogus')).toThrow(/unknown dataset 'bogus'/);
  });

  it('getRoom finds rooms by id', () => {
    const room = dataManager.getRoom('moonlit_gate_001');
    expect(room).not.toBeNull();
    expect(room.id).toBe('moonlit_gate_001');
    expect(room.region).toBe('moonlit_gate');
    expect(Array.isArray(room.exits)).toBe(true);
  });

  it('getRoom returns null for unknown ids', () => {
    expect(dataManager.getRoom('nope_not_a_room')).toBeNull();
  });

  it('data is stable across calls (same bundled reference)', () => {
    expect(dataManager.getData('weapons')).toBe(dataManager.getData('weapons'));
  });
});
