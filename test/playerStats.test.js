/**
 * PlayerStats unit tests — XP curve, level-ups, derived formulas, equipment.
 * Uses the real GameState singleton (reset between tests), the real
 * EventBus (cleared between tests), and the bundled data/*.json items.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { PlayerStats } from '../src/player/PlayerStats.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';
import { loadJson } from './helpers.js';

const progression = loadJson('data/progression.json');

describe('PlayerStats', () => {
  let stats;
  let seen;
  beforeEach(() => {
    gameState.reset();
    eventBus.clear();
    seen = { xpGained: [], leveledUp: [] };
    eventBus.on('player:xpGained', (p) => seen.xpGained.push(p));
    eventBus.on('player:leveledUp', (p) => seen.leveledUp.push(p));
    stats = new PlayerStats();
  });
  afterEach(() => {
    stats.destroy();
    eventBus.clear();
    gameState.reset();
  });

  it('xp thresholds follow data/progression.json (floor(80 * N^1.45))', () => {
    expect(stats.xpForNextLevel(1)).toBe(80);
    for (const n of [2, 3, 5, 10, 30]) {
      expect(stats.xpForNextLevel(n)).toBe(
        Math.floor(progression.xpCurve.base * Math.pow(n, progression.xpCurve.growth)),
      );
    }
  });

  it('a single level-up emits both events and applies growth', () => {
    const levels = stats.gainXp(80);
    expect(levels).toBe(1);
    expect(gameState.data.player.level).toBe(2);
    expect(seen.xpGained).toEqual([{ amount: 80, total: 80 }]);
    expect(seen.leveledUp).toHaveLength(1);
    expect(seen.leveledUp[0].level).toBe(2);
    expect(seen.leveledUp[0].stats.physicalAttack).toBeGreaterThan(0);
    // Growth applied: +2 str, +12 maxHp per progression.json.
    expect(gameState.data.player.stats.strength).toBe(8 + 2);
    expect(gameState.data.player.maxHp).toBe(60 + 12);
    expect(gameState.data.player.maxMp).toBe(20 + 4);
  });

  it('resolves multiple level-ups from one large gain', () => {
    // Cumulative: 80 + 218 + 393 = 691 to reach 4; 1288 to reach 5.
    const levels = stats.gainXp(1000);
    expect(levels).toBe(3);
    expect(gameState.data.player.level).toBe(4);
    expect(seen.leveledUp.map((e) => e.level)).toEqual([2, 3, 4]);
  });

  it('never exceeds the level cap', () => {
    const levels = stats.gainXp(1e12);
    expect(gameState.data.player.level).toBe(progression.levelCap);
    expect(levels).toBeLessThanOrEqual(progression.levelCap - 1);
    expect(seen.leveledUp.at(-1).level).toBe(progression.levelCap);
  });

  it('ignores non-positive XP', () => {
    expect(stats.gainXp(0)).toBe(0);
    expect(stats.gainXp(-50)).toBe(0);
    expect(seen.xpGained).toHaveLength(0);
    expect(seen.leveledUp).toHaveLength(0);
  });

  it('level-up grants a 30% max-HP surge heal (documented design choice)', () => {
    gameState.data.player.hp = 10;
    stats.gainXp(80); // level 2, maxHp 72
    expect(gameState.data.player.hp).toBe(10 + Math.round(72 * 0.3));
  });

  it('computes base derived stats from the documented formulas', () => {
    const d = stats.getDerived();
    expect(d.physicalAttack).toBe(Math.round(8 * 1.2)); // str 8, no gear
    expect(d.magicAttack).toBe(Math.round(8 * 1.2)); // int 8
    expect(d.defense).toBe(Math.round(8 * 0.8)); // con 8
    expect(d.magicDefense).toBe(Math.round(8 * 0.6));
    expect(d.critChance).toBeCloseTo(0.05 + 8 * 0.004, 5);
    expect(d.attackSpeed).toBeCloseTo(1 + 8 * 0.006, 5);
    expect(d.moveSpeed).toBe(1);
    expect(d.resistances).toEqual({
      physical: 0, fire: 0, ice: 0, lightning: 0, shadow: 0, holy: 0,
    });
  });

  it('applies equipment bonuses immediately on item:equipped', () => {
    gameState.equip('weapon', 'recruit_blade'); // stats: { atk: 8 }
    expect(stats.getDerived().physicalAttack).toBe(Math.round(8 * 1.2 + 8));
    gameState.equip('body', 'wayfarer_coat'); // stats: { def: 6, hp: 10 }
    const d = stats.getDerived();
    expect(d.defense).toBe(Math.round(8 * 0.8 + 6));
    expect(d.maxHpBonus).toBe(10);
    expect(stats.getEffectiveMaxHp()).toBe(60 + 10);
  });

  it('applies fractional resistances from gear', () => {
    gameState.equip('head', 'dusk_hood'); // resistances: { shadow: 0.1 }
    expect(stats.getDerived().resistances.shadow).toBe(0.1);
    const mdef = Math.round(8 * 0.6);
    expect(stats.getDefense('shadow')).toBeCloseTo(mdef / (mdef + 40) + 0.1, 5);
  });

  it('getDefense returns bounded mitigation for every damage type', () => {
    const bare = stats.getDefense('physical'); // before any gear
    gameState.equip('weapon', 'moonsteel_sabre');
    gameState.equip('body', 'wayfarer_coat');
    gameState.equip('head', 'dusk_hood');
    for (const t of ['physical', 'fire', 'ice', 'lightning', 'shadow', 'holy']) {
      const m = stats.getDefense(t);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(0.85);
    }
    // Physical mitigation rises with defense gear.
    expect(stats.getDefense('physical')).toBeGreaterThan(bare);
  });

  it('recalcs on unequip too', () => {
    gameState.equip('body', 'wayfarer_coat');
    expect(stats.getDerived().maxHpBonus).toBe(10);
    gameState.unequip('body');
    expect(stats.getDerived().maxHpBonus).toBe(0);
  });

  it('skips unknown item ids instead of throwing', () => {
    gameState.data.equipment.weapon = 'not_a_real_item';
    expect(() => stats.recalc()).not.toThrow();
  });
});
