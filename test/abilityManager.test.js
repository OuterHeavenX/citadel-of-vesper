/**
 * AbilityManager tests — unlock events, boss-died reward wiring, MP-gated cast.
 * Uses the real GameState singleton (reset between tests) with fake
 * eventBus/audioManager injected, except the boss:died listener test which
 * uses the real bus to prove the Wave 4 contract.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AbilityManager, MOONRISE_LEAP_ID } from '../src/abilities/AbilityManager.js';
import { gameState } from '../src/core/GameState.js';
import { eventBus } from '../src/core/EventBus.js';
import abilitiesData from '../data/abilities.json';

function makeFakes() {
  const emitted = [];
  return {
    emitted,
    eventBus: {
      on: () => {},
      off: () => {},
      emit: (event, payload) => emitted.push({ event, payload }),
    },
    audio: { played: [], playSfx(id) { this.played.push(id); } },
  };
}

function makeManager(fakes) {
  return new AbilityManager(abilitiesData, {
    gameState,
    eventBus: fakes.eventBus,
    audioManager: fakes.audio,
  });
}

describe('AbilityManager', () => {
  let fakes;
  beforeEach(() => {
    gameState.reset();
    fakes = makeFakes();
  });

  it('unlock() adds the id to gameState and emits player:abilityUnlocked once', () => {
    const am = makeManager(fakes);
    const seen = [];
    const off = eventBus.on('player:abilityUnlocked', (p) => seen.push(p));
    try {
      expect(am.has(MOONRISE_LEAP_ID)).toBe(false);
      expect(am.unlock(MOONRISE_LEAP_ID)).toBe(true);
      expect(am.has(MOONRISE_LEAP_ID)).toBe(true);
      expect(gameState.data.player.abilities).toContain(MOONRISE_LEAP_ID);
      // gameState.unlockAbility emits player:abilityUnlocked on the real bus;
      // the manager must not double-emit.
      expect(seen).toEqual([{ abilityId: MOONRISE_LEAP_ID }]);
    } finally {
      off();
    }
  });

  it('unlock() plays the secret sfx and is idempotent', () => {
    const am = makeManager(fakes);
    const seen = [];
    const off = eventBus.on('player:abilityUnlocked', (p) => seen.push(p));
    try {
      am.unlock(MOONRISE_LEAP_ID);
      expect(fakes.audio.played).toContain('secret');
      expect(am.unlock(MOONRISE_LEAP_ID)).toBe(false); // already unlocked
      expect(seen).toHaveLength(1); // no re-emit on idempotent call
    } finally {
      off();
    }
  });

  it('unlock() throws on unknown ids', () => {
    const am = makeManager(fakes);
    expect(() => am.unlock('no_such_ability')).toThrow(/unknown ability/);
  });

  it('boss:died for chapel_warden unlocks moonrise_leap (Wave 4 contract)', () => {
    const seen = [];
    const off = eventBus.on('player:abilityUnlocked', (p) => seen.push(p));
    const am = new AbilityManager(abilitiesData, {
      gameState,
      eventBus,
      audioManager: fakes.audio,
    });
    try {
      eventBus.emit('boss:died', { bossId: 'chapel_warden', roomId: 'r1', reward: 'x' });
      expect(am.has(MOONRISE_LEAP_ID)).toBe(true);
      expect(seen).toEqual([{ abilityId: MOONRISE_LEAP_ID }]);
    } finally {
      off();
      am.destroy();
    }
  });

  it('boss:died for other bosses grants nothing', () => {
    const am = new AbilityManager(abilitiesData, {
      gameState,
      eventBus,
      audioManager: fakes.audio,
    });
    try {
      eventBus.emit('boss:died', { bossId: 'sable_matriarch', roomId: 'r2', reward: 'y' });
      expect(am.has(MOONRISE_LEAP_ID)).toBe(false);
    } finally {
      am.destroy();
    }
  });

  it('getTraversalAbilities() lists traversal defs only', () => {
    const am = makeManager(fakes);
    const ids = am.getTraversalAbilities().map((a) => a.id);
    expect(ids).toContain(MOONRISE_LEAP_ID);
    expect(ids).toContain('gale_dash');
    expect(ids).not.toContain('cinder_wave');
  });

  it('getExtraJumps() is 0 locked, 1 after moonrise_leap', () => {
    const am = makeManager(fakes);
    expect(am.getExtraJumps()).toBe(0);
    am.unlock(MOONRISE_LEAP_ID);
    expect(am.getExtraJumps()).toBe(1);
  });

  it('cast() deducts MP only when learned and affordable', () => {
    const am = makeManager(fakes);
    expect(am.cast('cinder_wave')).toBe(false); // not learned
    am.learn('cinder_wave');
    gameState.setMp(20); // maxMp is 20 in the fresh state; setMp clamps
    expect(am.cast('cinder_wave')).toBe(true);
    expect(gameState.data.player.mp).toBe(12); // 20 - 8
    gameState.setMp(5);
    expect(am.cast('cinder_wave')).toBe(false); // can't afford
    expect(gameState.data.player.mp).toBe(5);
  });

  it('learn() rejects non-spells', () => {
    const am = makeManager(fakes);
    expect(() => am.learn(MOONRISE_LEAP_ID)).toThrow(/not a spell/);
  });
});
