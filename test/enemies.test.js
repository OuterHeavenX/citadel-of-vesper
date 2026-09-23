/**
 * test/enemies.test.js — Wave 2 enemy systems (W2-ENEMY).
 *
 * Covers: EnemyFactory unknown-id error + subclass resolution, telegraph ->
 * attack sequencing (pure state machine, headless), drop-roll math, plus
 * stagger/poise, block, and death-payload behavior. No Phaser needed:
 * enemies run headless with scene = null and injected ctx fakes.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  Enemy,
  EnemyFactory,
  AshHound,
  RustboundRevenant,
  rollDrops,
} from '../src/enemies/index.js';
import { eventBus } from '../src/core/EventBus.js';
import enemiesData from '../data/enemies.json';

const defOf = (id) => enemiesData.find((d) => d.id === id);

function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function makeCtx(over = {}) {
  const calls = { damage: [], sfx: [], pickups: [], xp: 0, seen: [], kills: [] };
  const ctx = {
    roomId: 'test_room',
    rng: () => 0.5,
    dealDamage: (source, target, opts) => {
      calls.damage.push({ source, target, opts });
      return { dealt: opts.amount, killed: false, critical: false };
    },
    getPlayer: () => null,
    playSfx: (id) => calls.sfx.push(id),
    spawnPickup: (x, y, ref) => calls.pickups.push(ref),
    addXp: (n) => {
      calls.xp += n;
    },
    bestiarySeen: (id) => calls.seen.push(id),
    bestiaryKill: (id) => calls.kills.push(id),
    ...over,
  };
  return { calls, ctx };
}

const fakePlayer = (x = 60, y = 0) => ({
  x,
  y,
  takeDamage() {},
  getDefense() {
    return { flat: 0, multiplier: 1 };
  },
  isInvulnerable() {
    return false;
  },
});

const playerPos = (p) => ({ x: p.x, y: p.y, ref: p });

beforeEach(() => {
  eventBus.clear();
  EnemyFactory.registerDefs(enemiesData);
});

// ---------------------------------------------------------------- factory

describe('EnemyFactory', () => {
  it('throws a clear error naming the id for unknown enemy ids', () => {
    expect(() => EnemyFactory.create('nope_not_real', null, 0, 0, 'i1', {})).toThrow(
      /unknown enemy id 'nope_not_real'/,
    );
  });

  it('creates the registered subclass for a known id', () => {
    const e = EnemyFactory.create('ash_hound', null, 10, 20, 'room:1', {});
    expect(e).toBeInstanceOf(AshHound);
    expect(e).toBeInstanceOf(Enemy);
    expect(e.x).toBe(10);
    expect(e.y).toBe(20);
  });

  it('falls back to the base Enemy class when no subclass is registered', () => {
    const mystery = {
      id: 'mystery_blob',
      name: 'Mystery Blob',
      level: 1,
      hp: 10,
      stats: { attack: 5, defense: 1 },
      behaviors: [],
      drops: [],
      xp: 5,
      sprite: 'mystery_blob',
      lore: 'test',
    };
    EnemyFactory.registerDefs([...enemiesData, mystery]);
    const e = EnemyFactory.create('mystery_blob', null, 0, 0, 'i2', {});
    expect(e).toBeInstanceOf(Enemy);
    expect(e).not.toBeInstanceOf(AshHound);
  });
});

// ------------------------------------------------------- telegraph sequencing

describe('telegraph -> attack sequencing', () => {
  it('runs windup (data windup time) -> strike (once) -> recover -> pursue', () => {
    const { calls, ctx } = makeCtx();
    const player = fakePlayer(60, 0);
    const hound = new AshHound(null, defOf('ash_hound'), 't1', 0, 0, {
      ...ctx,
      getPlayer: () => player,
    });

    let strikes = 0;
    const origStrike = hound.strikeAttack.bind(hound);
    hound.strikeAttack = (p) => {
      strikes += 1;
      return origStrike(p);
    };

    hound.beginAttack('pounce');
    expect(hound.getState()).toBe('attack');
    expect(hound.attackPhase).toBe('windup');
    // anticipation pause: frozen during windup
    hound.update(1 / 60, playerPos(player));
    expect(hound.vx).toBe(0);

    const dt = 1 / 60;
    let steps = 0;
    while (strikes === 0 && steps < 600) {
      hound.update(dt, playerPos(player));
      steps += 1;
    }
    // windup matches the data telegraph (0.45s) within a frame of tolerance
    expect(strikes).toBe(1);
    expect(steps * dt).toBeGreaterThan(0.4);
    expect(steps * dt).toBeLessThan(0.55);
    expect(hound.attackPhase).toBe('strike');

    // strike + recover play out, then the hound returns to pursue (player near)
    steps = 0;
    while (hound.getState() === 'attack' && steps < 600) {
      hound.update(dt, playerPos(player));
      steps += 1;
    }
    expect(strikes).toBe(1); // exactly one strike per attack
    expect(hound.getState()).toBe('pursue');
    expect(hound.cooldownT).toBeGreaterThan(0);

    // damage went out ONLY through the injected DamageSystem path
    expect(calls.damage.length).toBeGreaterThan(0);
    for (const d of calls.damage) {
      expect(d.source).toEqual({ id: 'ash_hound', kind: 'enemy' });
    }
  });

  it('does not strike when the windup is interrupted by death', () => {
    const { ctx } = makeCtx({ rng: () => 0.99 }); // no block, no drops
    const hound = new AshHound(null, defOf('ash_hound'), 't2', 0, 0, ctx);
    let strikes = 0;
    hound.strikeAttack = () => {
      strikes += 1;
    };
    hound.beginAttack('pounce');
    hound.takeDamage(9999, { type: 'physical', attackerX: 10 });
    expect(hound.getState()).toBe('dead');
    for (let i = 0; i < 120; i++) hound.update(1 / 60, null);
    expect(strikes).toBe(0);
  });
});

// ---------------------------------------------------------------- drop rolls

describe('rollDrops', () => {
  it('rolls each entry independently, honoring quantity', () => {
    const drops = [
      { itemId: 'a', chance: 0.5, quantity: 1 },
      { itemId: 'b', chance: 0.5, quantity: 2 },
      { itemId: 'c', chance: 0.0, quantity: 3 },
    ];
    expect(rollDrops(drops, seqRng([0.1, 0.4, 0.99]))).toEqual(['a', 'b', 'b']);
  });

  it('returns [] for empty/missing tables', () => {
    expect(rollDrops([], () => 0)).toEqual([]);
    expect(rollDrops(undefined, () => 0)).toEqual([]);
  });
});

// ------------------------------------------------------------- damage model

describe('Enemy damage model', () => {
  it('staggers when poise breaks, then recovers to pursue', () => {
    const { ctx } = makeCtx({ rng: () => 0.99 });
    const player = fakePlayer(120, 0); // in aggro (195) but outside pounce range (85)
    const hound = new AshHound(null, defOf('ash_hound'), 't3', 0, 0, {
      ...ctx,
      getPlayer: () => player,
    });
    expect(hound.maxPoise).toBe(20 + 2 * 5); // 20 + defense*5
    hound.hp = 100; // test-only: survive long enough to break poise
    for (let i = 0; i < 3; i++) {
      hound.invulnT = 0; // test-only: bypass hit i-frames between blows
      hound.takeDamage(10, { type: 'physical', attackerX: 50 });
    }
    expect(hound.getState()).toBe('stagger');
    // 0.67s: stagger (0.55s) ends, hound is pursuing but not yet in range
    for (let i = 0; i < 40; i++) hound.update(1 / 60, playerPos(player));
    expect(hound.getState()).toBe('pursue');
  });

  it('revenant blocks frontal hits sometimes, never rear hits', () => {
    const blocked = makeCtx({ rng: () => 0.0 }); // always rolls under block chance
    const rev = new RustboundRevenant(null, defOf('rustbound_revenant'), 't4', 0, 0, blocked.ctx);
    rev.facing = 1;
    expect(rev.takeDamage(20, { type: 'physical', attackerX: 50 })).toBe(0);
    expect(rev.hp).toBe(40);

    const rear = makeCtx({ rng: () => 0.0 });
    const rev2 = new RustboundRevenant(null, defOf('rustbound_revenant'), 't5', 0, 0, rear.ctx);
    rev2.facing = 1;
    expect(rev2.takeDamage(20, { type: 'physical', attackerX: -50 })).toBe(20);
    expect(rev2.hp).toBe(20);
  });

  it('getDefense reports flat defense and resistance multipliers', () => {
    const { ctx } = makeCtx();
    const hound = new AshHound(null, defOf('ash_hound'), 't6', 0, 0, ctx);
    expect(hound.getDefense('physical')).toEqual({ flat: 2, multiplier: 1 });
    expect(hound.getDefense('fire')).toEqual({ flat: 2, multiplier: 0.75 }); // 0.25 resist
  });

  it('death emits enemy:died, awards XP, records bestiary, spawns pickups', () => {
    // rng sequence: 2 constructor rolls, block roll (0.99 = no block),
    // then 2 drop rolls (0.01 = both drop)
    const { calls, ctx } = makeCtx({ rng: seqRng([0.5, 0.5, 0.99, 0.01, 0.01]) });
    const seen = [];
    eventBus.on('enemy:died', (p) => seen.push(p));
    const rev = new RustboundRevenant(null, defOf('rustbound_revenant'), 'roomX:7', 100, 50, ctx);
    rev.takeDamage(999, { type: 'holy', attackerX: 150 });

    expect(rev.getState()).toBe('dead');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      enemyId: 'rustbound_revenant',
      instanceId: 'roomX:7',
      roomId: 'test_room',
      drops: ['ember_tonic', 'iron_signet'],
    });
    expect(calls.xp).toBe(60);
    expect(calls.kills).toEqual(['rustbound_revenant']);
    expect(calls.pickups).toEqual(['ember_tonic', 'iron_signet']);
    // second lethal hit is a no-op — no double death
    rev.takeDamage(999, {});
    expect(seen).toHaveLength(1);
    expect(calls.xp).toBe(60);
  });

  it('sleeping enemies skip AI when off-camera', () => {
    const { ctx } = makeCtx();
    const hound = new AshHound(null, defOf('ash_hound'), 't8', 5000, 5000, ctx);
    // fake a camera whose view does not contain the enemy
    hound.scene = { cameras: { main: { worldView: { x: 0, y: 0, width: 480, height: 270 } } } };
    const player = fakePlayer(5005, 5000);
    hound.update(1 / 60, playerPos(player));
    expect(hound.getState()).toBe('idle'); // never aggroed while asleep
    expect(hound.vx).toBe(0);
  });
});
