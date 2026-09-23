/**
 * StatusEffects unit tests — apply/remove/has, DoT ticks via DamageSystem
 * with ignoreIframes, expiry, modifier hooks. Phaser-free.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StatusEffects, statusEffects } from '../src/combat/StatusEffects.js';

function makeTarget(overrides = {}) {
  return {
    id: 't1',
    takeDamage: vi.fn(),
    getDefense: () => 0,
    isInvulnerable: () => true, // DoTs must bypass via ignoreIframes
    heal: vi.fn(),
    addModifier: vi.fn(),
    removeModifier: vi.fn(),
    ...overrides,
  };
}

describe('StatusEffects', () => {
  let fx;

  beforeEach(() => {
    fx = new StatusEffects();
  });

  it('burn ticks damage through DamageSystem bypassing i-frames', () => {
    const t = makeTarget();
    fx.apply(t, 'burn', { duration: 2, tickMs: 500, power: 2 });
    expect(fx.has(t, 'burn')).toBe(true);

    fx.update(0.5);
    expect(t.takeDamage).toHaveBeenCalledTimes(1);
    expect(t.takeDamage.mock.calls[0][0]).toBe(2);
    const info = t.takeDamage.mock.calls[0][1];
    expect(info.source).toEqual({ id: 'status:burn', kind: 'environment' });
    expect(info.type).toBe('fire');

    fx.update(1.5); // 3 more ticks, then expiry at t=2s
    expect(t.takeDamage).toHaveBeenCalledTimes(4);
    expect(fx.has(t, 'burn')).toBe(false);
    expect(t.removeModifier).toHaveBeenCalledWith('status:burn');
  });

  it('re-applying refreshes duration and keeps the stronger power', () => {
    const t = makeTarget();
    fx.apply(t, 'poison', { duration: 2, power: 1 });
    fx.update(1.5);
    fx.apply(t, 'poison', { duration: 2, power: 3 }); // refresh
    expect(fx.getRemaining(t, 'poison')).toBeCloseTo(2, 5);
    fx.update(1.9);
    expect(fx.has(t, 'poison')).toBe(true); // would have expired without refresh
    expect(t.takeDamage).toHaveBeenCalledWith(3, expect.anything());
  });

  it('chill applies a slow modifier, removed on expiry', () => {
    const t = makeTarget();
    fx.apply(t, 'chill', { duration: 1 });
    expect(t.addModifier).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'status:chill', kind: 'chill', moveSpeedMult: 0.5 }),
    );
    fx.update(1.0);
    expect(fx.has(t, 'chill')).toBe(false);
    expect(t.removeModifier).toHaveBeenCalledWith('status:chill');
  });

  it('stun applies a stun modifier', () => {
    const t = makeTarget();
    fx.apply(t, 'stun', { duration: 1 });
    expect(t.addModifier).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'status:stun', kind: 'stun', stunned: true }),
    );
  });

  it('regen ticks heal through the target heal hook', () => {
    const t = makeTarget();
    fx.apply(t, 'regen', { duration: 2, tickMs: 1000, power: 3 });
    fx.update(1.0);
    fx.update(1.0);
    expect(t.heal).toHaveBeenCalledTimes(2);
    expect(t.heal).toHaveBeenCalledWith(3, { source: 'status:regen' });
    expect(fx.has(t, 'regen')).toBe(false);
  });

  it('remove() drops the effect and its modifier early', () => {
    const t = makeTarget();
    fx.apply(t, 'burn', { duration: 10 });
    fx.remove(t, 'burn');
    expect(fx.has(t, 'burn')).toBe(false);
    fx.update(5);
    expect(t.takeDamage).not.toHaveBeenCalled();
  });

  it('clearTarget drops all effects on death', () => {
    const t = makeTarget({ isDead: () => true });
    fx.apply(t, 'burn', { duration: 10 });
    fx.apply(t, 'chill', { duration: 10 });
    fx.update(0.016);
    expect(fx.has(t, 'burn')).toBe(false);
    expect(fx.has(t, 'chill')).toBe(false);
    expect(t.takeDamage).not.toHaveBeenCalled();
  });

  it('throws on unknown effect ids and non-positive durations', () => {
    const t = makeTarget();
    expect(() => fx.apply(t, 'meteor', {})).toThrow(/unknown effect/);
    expect(() => fx.apply(t, 'burn', { duration: 0 })).toThrow(/positive/);
  });

  it('works when the target exposes no modifier/heal hooks', () => {
    const t = { id: 'bare', takeDamage: vi.fn(), getDefense: () => 0, isInvulnerable: () => false };
    expect(() => fx.apply(t, 'burn', { duration: 1, tickMs: 500, power: 1 })).not.toThrow();
    fx.update(0.5);
    expect(t.takeDamage).toHaveBeenCalledTimes(1);
    fx.update(0.6);
    expect(fx.has(t, 'burn')).toBe(false);
  });

  it('the shared singleton is a StatusEffects instance', () => {
    expect(statusEffects).toBeInstanceOf(StatusEffects);
  });
});
