/**
 * DamageSystem unit tests — mitigation math, crits, i-frames, event payloads.
 * Phaser-free: fake targets only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DamageSystem, CRIT_MULTIPLIER, MAX_MITIGATION } from '../src/combat/DamageSystem.js';
import { eventBus } from '../src/core/EventBus.js';

function makeTarget(overrides = {}) {
  return {
    id: 'e1',
    kind: 'enemy',
    hp: 30,
    takeDamage: vi.fn(),
    getDefense: () => 0,
    isInvulnerable: () => false,
    getHp() { return this.hp; },
    ...overrides,
  };
}

const SRC = { id: 'player', kind: 'player' };

describe('DamageSystem.applyDamage', () => {
  let hits;
  let playerHits;
  let enemyHits;

  beforeEach(() => {
    eventBus.clear();
    hits = [];
    playerHits = [];
    enemyHits = [];
    eventBus.on('combat:hitLanded', (p) => hits.push(p));
    eventBus.on('player:damaged', (p) => playerHits.push(p));
    eventBus.on('enemy:damaged', (p) => enemyHits.push(p));
  });

  afterEach(() => eventBus.clear());

  it('applies mitigation from getDefense(type)', () => {
    const t = makeTarget({ getDefense: () => 0.2 });
    const r = DamageSystem.applyDamage(SRC, t, { amount: 100, type: 'physical' });
    expect(r).toEqual({ dealt: 80, killed: false, critical: false });
    expect(t.takeDamage).toHaveBeenCalledTimes(1);
    expect(t.takeDamage.mock.calls[0][0]).toBe(80);
  });

  it('passes source/type/knockback/critical through to takeDamage info', () => {
    const t = makeTarget();
    DamageSystem.applyDamage(SRC, t, {
      amount: 40, type: 'fire', knockback: { x: 50, y: -10 }, hitStun: 0.2,
    });
    const info = t.takeDamage.mock.calls[0][1];
    expect(info.source).toEqual({ id: 'player', kind: 'player' });
    expect(info.type).toBe('fire');
    expect(info.knockback).toEqual({ x: 50, y: -10 });
    expect(info.hitStun).toBe(0.2);
    expect(info.critical).toBe(false);
  });

  it('honors an explicit critical flag (crit x1.5 pre-mitigation)', () => {
    const t = makeTarget({ getDefense: () => 0.2 });
    const r = DamageSystem.applyDamage(SRC, t, { amount: 100, critical: true });
    expect(r.critical).toBe(true);
    expect(r.dealt).toBe(Math.round(100 * CRIT_MULTIPLIER * 0.8));
  });

  it('rolls crits when canCrit and no explicit flag (deterministic at 0/1)', () => {
    const t = makeTarget();
    expect(DamageSystem.applyDamage(SRC, t, { amount: 10, canCrit: true, critChance: 1 }).critical).toBe(true);
    expect(DamageSystem.applyDamage(SRC, t, { amount: 10, canCrit: true, critChance: 0 }).critical).toBe(false);
    expect(DamageSystem.applyDamage(SRC, t, { amount: 10, canCrit: false, critChance: 1 }).critical).toBe(false);
  });

  it('clamps mitigation to MAX_MITIGATION', () => {
    const t = makeTarget({ getDefense: () => 5 });
    const r = DamageSystem.applyDamage(SRC, t, { amount: 100 });
    expect(r.dealt).toBe(Math.round(100 * (1 - MAX_MITIGATION)));
  });

  it('treats non-positive damage as a no-op with no events', () => {
    const t = makeTarget();
    expect(DamageSystem.applyDamage(SRC, t, { amount: 0 })).toEqual({ dealt: 0, killed: false, critical: false });
    expect(DamageSystem.applyDamage(SRC, t, { amount: -5 })).toEqual({ dealt: 0, killed: false, critical: false });
    expect(t.takeDamage).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);
  });

  it('i-frames block damage unless ignoreIframes', () => {
    const t = makeTarget({ isInvulnerable: () => true });
    const blocked = DamageSystem.applyDamage(SRC, t, { amount: 50 });
    expect(blocked.dealt).toBe(0);
    expect(t.takeDamage).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);

    const through = DamageSystem.applyDamage(SRC, t, { amount: 50, ignoreIframes: true });
    expect(through.dealt).toBe(50);
    expect(t.takeDamage).toHaveBeenCalledTimes(1);
  });

  it('never double-kills an already-dead target', () => {
    const t = makeTarget({ isDead: () => true });
    const r = DamageSystem.applyDamage(SRC, t, { amount: 50 });
    expect(r).toEqual({ dealt: 0, killed: true, critical: false });
    expect(t.takeDamage).not.toHaveBeenCalled();
  });

  it('reads killed from takeDamage return (true or {killed:true})', () => {
    const a = makeTarget({ takeDamage: vi.fn(() => true) });
    expect(DamageSystem.applyDamage(SRC, a, { amount: 10 }).killed).toBe(true);
    const b = makeTarget({ takeDamage: vi.fn(() => ({ killed: true })) });
    expect(DamageSystem.applyDamage(SRC, b, { amount: 10 }).killed).toBe(true);
    const c = makeTarget({ takeDamage: vi.fn(() => undefined) });
    expect(DamageSystem.applyDamage(SRC, c, { amount: 10 }).killed).toBe(false);
  });

  it('emits combat:hitLanded with the catalog payload shape', () => {
    const t = makeTarget();
    DamageSystem.applyDamage({ id: 'wisp_7', kind: 'enemy' }, t, { amount: 20, critical: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ attacker: 'wisp_7', target: 'e1', amount: 30, critical: true });
  });

  it('emits player:damaged for player targets, enemy:damaged for enemies', () => {
    const p = makeTarget({ id: 'player', kind: 'player', getMaxHp: () => 60 });
    DamageSystem.applyDamage({ id: 'ghoul_2', kind: 'enemy' }, p, { amount: 12 });
    expect(playerHits).toHaveLength(1);
    expect(playerHits[0]).toEqual({ amount: 12, source: 'ghoul_2', hp: 30, maxHp: 60 });
    expect(enemyHits).toHaveLength(0);

    const e = makeTarget();
    DamageSystem.applyDamage(SRC, e, { amount: 12 });
    expect(enemyHits).toHaveLength(1);
    expect(enemyHits[0]).toEqual({ instanceId: 'e1', amount: 12, hp: 30 });
    expect(playerHits).toHaveLength(1);
  });

  it('throws on a target without takeDamage', () => {
    expect(() => DamageSystem.applyDamage(SRC, {}, { amount: 10 })).toThrow(/takeDamage/);
    expect(() => DamageSystem.applyDamage(SRC, null, { amount: 10 })).toThrow(/takeDamage/);
  });
});
