/**
 * test/boss.test.js — W4-BOSS headless logic tests.
 *
 * Covers: schema validation (bosses.json + boss_attacks.json), boss <->
 * attack-pattern cross-references, entrance -> encounterStarted sequencing,
 * phase transitions at data thresholds, telegraphed attack execution
 * (damage ONLY through the injected DamageSystem path), all five attack
 * kinds, death rewards (XP + moonrise_leap / moonsteel_sabre), exit
 * lock/unlock on RoomManager, and the DamageSystem 'enemy:damaged' feed
 * GameScene's boss bar relies on (instanceId === bossId).
 *
 * No Phaser: Boss runs headless with scene = null and injected ctx fakes,
 * mirroring the patterns in test/enemies.test.js.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { schemaSuite } from './helpers.js';
import { Boss, phaseForFraction, resolveFloorY } from '../src/bosses/Boss.js';
import { EventBus } from '../src/core/EventBus.js';
import { eventBus } from '../src/core/EventBus.js';
import { gameState } from '../src/core/GameState.js';
import { DamageSystem } from '../src/combat/DamageSystem.js';
import { RoomManager } from '../src/rooms/RoomManager.js';
import bossesData from '../data/bosses.json';
import attacksData from '../data/boss_attacks.json';

schemaSuite('boss.schema.json', 'bosses.json');
schemaSuite('boss_attack.schema.json', 'boss_attacks.json');

const wardenDef = bossesData.find((b) => b.id === 'chapel_warden');
const matriarchDef = bossesData.find((b) => b.id === 'sable_matriarch');

const fakePlayerAt = (x, y = 240) => ({
  id: 'player',
  kind: 'player',
  x,
  y,
  takeDamage() { return 0; },
  getDefense() { return { flat: 0, multiplier: 1 }; },
  isInvulnerable() { return false; },
});

/** Isolated bus + recording ctx fakes for one Boss instance. */
function makeFakes(over = {}) {
  const bus = new EventBus();
  const seen = [];
  bus.on('boss:encounterStarted', (p) => seen.push(['encounterStarted', p]));
  bus.on('boss:phaseChanged', (p) => seen.push(['phaseChanged', p]));
  bus.on('boss:died', (p) => seen.push(['died', p]));
  const calls = {
    damage: [], sfx: [], xp: 0, items: [], lockExits: [], cameraLock: [],
    banners: [], victims: [], hurtboxes: [], hitboxes: [], projectiles: [],
    minions: [], fx: [],
  };
  const player = fakePlayerAt(100);
  const ctx = {
    roomId: 'arena_test',
    rng: () => 0.5,
    eventBus: bus,
    gameState,
    dealDamage: (source, target, opts) => {
      calls.damage.push({ source, target, opts });
      return { dealt: opts.amount, killed: false, critical: false };
    },
    getPlayer: () => player,
    getFloorY: () => 240,
    hitboxSystem: {
      registerHurtbox: (e) => calls.hurtboxes.push(e.id),
      unregisterHurtbox: () => {},
      spawnHitbox: (owner, spec) => {
        calls.hitboxes.push({ owner, spec });
        return 'hb_test';
      },
    },
    projectileSystem: {
      fire: (spec) => {
        calls.projectiles.push(spec);
        return {};
      },
    },
    effectsManager: {
      registerVictim: (id) => calls.victims.push(id),
      unregisterVictim: () => {},
    },
    spawnMinion: (enemyId, x, y) => {
      const m = { id: enemyId, x, y, isAlive: () => true };
      calls.minions.push(m);
      return m;
    },
    playSfx: (id) => calls.sfx.push(id),
    addXp: (n) => { calls.xp += n; },
    addItem: (itemId, qty) => calls.items.push({ itemId, qty }),
    onCameraLock: (locked) => calls.cameraLock.push(locked),
    onShowBanner: (name, title) => calls.banners.push({ name, title }),
    onLockExits: (locked) => calls.lockExits.push(locked),
    fx: {
      shake: (t) => calls.fx.push(['shake', t]),
      hitPause: (ms) => calls.fx.push(['hitPause', ms]),
      landDust: (x, y) => calls.fx.push(['landDust', x, y]),
    },
    ...over,
  };
  return { calls, ctx, bus, seen, player };
}

/** Fresh boss with the entrance already completed (fight is live). */
function liveBoss(def, fakes, x = 700, y = 240) {
  const boss = new Boss(null, def, x, y, fakes.ctx);
  boss.update(def.entrance.duration + 0.1, { x: 100, y: 240 });
  return boss;
}

beforeEach(() => {
  eventBus.clear(); // DamageSystem's singleton bus
  gameState.reset();
});

// ------------------------------------------------- data cross-references

describe('boss <-> attack pattern cross-references', () => {
  it('every attack id referenced by bosses.json exists in boss_attacks.json with a matching bossId', () => {
    const byId = new Map(attacksData.map((a) => [a.id, a]));
    for (const boss of bossesData) {
      const refs = [
        ...boss.attacks.map((a) => a.id),
        ...boss.phases.flatMap((p) => p.addsAttacks ?? []),
      ];
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const pat = byId.get(ref);
        expect(pat, `${boss.id} references unknown attack '${ref}'`).toBeDefined();
        expect(pat.bossId).toBe(boss.id);
      }
    }
  });

  it('warden has 2 attacks across 2 phases; matriarch has 4 across 3 phases', () => {
    const w = new Map(attacksData.filter((a) => a.bossId === 'chapel_warden').map((a) => [a.id, a]));
    expect([...w.keys()].sort()).toEqual(['bell_toll', 'chapel_slam']);
    const m = new Map(attacksData.filter((a) => a.bossId === 'sable_matriarch').map((a) => [a.id, a]));
    expect([...m.keys()].sort()).toEqual([
      'grief_volley', 'lantern_call', 'matriarch_sweep', 'throne_quake',
    ]);
  });
});

// ------------------------------------------------------------- pure helpers

describe('phaseForFraction / resolveFloorY', () => {
  it('warden: phase 2 at hp <= 0.5', () => {
    expect(phaseForFraction(wardenDef.phases, 1.0)).toBe(1);
    expect(phaseForFraction(wardenDef.phases, 0.51)).toBe(1);
    expect(phaseForFraction(wardenDef.phases, 0.5)).toBe(2);
    expect(phaseForFraction(wardenDef.phases, 0.1)).toBe(2);
  });

  it('matriarch: phase 2 at hp <= 0.66, phase 3 at hp <= 0.33', () => {
    expect(phaseForFraction(matriarchDef.phases, 0.67)).toBe(1);
    expect(phaseForFraction(matriarchDef.phases, 0.66)).toBe(2);
    expect(phaseForFraction(matriarchDef.phases, 0.34)).toBe(2);
    expect(phaseForFraction(matriarchDef.phases, 0.33)).toBe(3);
  });

  it('resolveFloorY picks the top solid under x, falls back to room height', () => {
    const def = { width: 960, height: 270, geometry: { solids: [{ x: 0, y: 240, w: 960, h: 30 }] } };
    expect(resolveFloorY(def, 700)).toBe(240);
    expect(resolveFloorY(def, 2000)).toBe(270);
    expect(resolveFloorY({}, 0)).toBe(270);
  });
});

// ---------------------------------------------------------------- lifecycle

describe('entrance -> fight lifecycle', () => {
  it('starts in entrance: invulnerable, banner shown, camera locked', () => {
    const fakes = makeFakes();
    const boss = new Boss(null, wardenDef, 700, 240, fakes.ctx);
    expect(boss.state).toBe('entrance');
    expect(boss.isInvulnerable()).toBe(true);
    expect(boss.getHp()).toBe(300);
    expect(boss.getMaxHp()).toBe(300);
    expect(boss.getPhase()).toBe(1);
    expect(boss.getAvailableAttacks()).toEqual(['chapel_slam']);
    expect(fakes.calls.banners).toEqual([{ name: 'Chapel Warden', title: 'Warden of the Gate Chapel' }]);
    expect(fakes.calls.cameraLock).toEqual([true]);
    expect(fakes.calls.lockExits).toEqual([true]); // sealed from the moment of spawn
    expect(fakes.calls.victims).toEqual(['chapel_warden']);
    expect(fakes.calls.hurtboxes).toEqual(['chapel_warden']);
    // Invulnerable: damage is refused during the entrance.
    expect(boss.takeDamage(100, {})).toBe(0);
    expect(boss.getHp()).toBe(300);
  });

  it('entrance completes: boss:encounterStarted, exits lock, fight begins', () => {
    const fakes = makeFakes();
    const boss = new Boss(null, wardenDef, 700, 240, fakes.ctx);
    boss.update(1.0, { x: 100, y: 240 });
    expect(boss.state).toBe('entrance'); // 2.0s entrance not done yet
    boss.update(1.1, { x: 100, y: 240 });
    expect(boss.state).toBe('combat');
    expect(boss.isInvulnerable()).toBe(false);
    expect(fakes.seen).toContainEqual([
      'encounterStarted',
      { bossId: 'chapel_warden', roomId: 'arena_test' },
    ]);
    expect(fakes.calls.lockExits).toEqual([true]);
    expect(fakes.calls.cameraLock).toEqual([true, false]);
  });

  it('constructor throws a clear error when an attack pattern is missing', () => {
    const fakes = makeFakes();
    const bad = { ...wardenDef, attacks: [{ id: 'nope_not_real', name: 'X', telegraph: 'y' }] };
    expect(() => new Boss(null, bad, 0, 0, fakes.ctx)).toThrow(/attack pattern 'nope_not_real' missing/);
  });
});

// ------------------------------------------------------------------- phases

describe('phase transitions', () => {
  it('warden crosses to phase 2 at hp <= 0.5: event, new attack, brief invuln', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    boss.takeDamage(150, {}); // 150/300 = 0.5
    expect(boss.getPhase()).toBe(2);
    expect(boss.getAvailableAttacks()).toEqual(['chapel_slam', 'bell_toll']);
    expect(fakes.seen).toContainEqual(['phaseChanged', { bossId: 'chapel_warden', phase: 2 }]);
    expect(boss.state).toBe('phaseShift');
    expect(boss.isInvulnerable()).toBe(true);
    expect(boss.takeDamage(50, {})).toBe(0); // refused mid-roar
    boss.update(1.5, { x: 100, y: 240 });
    expect(boss.state).toBe('combat');
    expect(boss.isInvulnerable()).toBe(false);
  });

  it('matriarch escalates through 3 phases with the right attack unlocks', () => {
    const fakes = makeFakes();
    const boss = liveBoss(matriarchDef, fakes);
    expect(boss.getAvailableAttacks()).toEqual(['matriarch_sweep', 'grief_volley']);

    boss.takeDamage(900 - 594 + 1, {}); // hp 593 -> fraction 0.659
    expect(boss.getPhase()).toBe(2);
    expect(boss.getAvailableAttacks()).toContain('lantern_call');
    expect(fakes.seen).toContainEqual(['phaseChanged', { bossId: 'sable_matriarch', phase: 2 }]);
    boss.update(1.5, { x: 100, y: 240 });

    boss.takeDamage(594 - 297 + 1, {}); // hp 296 -> fraction 0.329
    expect(boss.getPhase()).toBe(3);
    expect(boss.getAvailableAttacks()).toContain('throne_quake');
    expect(fakes.seen).toContainEqual(['phaseChanged', { bossId: 'sable_matriarch', phase: 3 }]);
  });
});

// ------------------------------------------------------------------ attacks

describe('telegraphed attacks (damage only via the DamageSystem path)', () => {
  it('chapel_slam: no damage during windup; hitbox spawns on strike via HitboxSystem', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    const p = { x: 640, y: 240, ref: fakePlayerAt(640) };
    boss.beginAttack('chapel_slam');
    expect(boss.attackPhase).toBe('windup');
    boss.update(0.5, p);
    expect(boss.attackPhase).toBe('windup');
    expect(fakes.calls.hitboxes).toHaveLength(0); // telegraph only
    expect(fakes.calls.sfx).toContain('bell_chime'); // windup sfx
    boss.update(0.4, p); // windup (0.85) elapses -> strike
    expect(fakes.calls.hitboxes).toHaveLength(1);
    const { owner, spec } = fakes.calls.hitboxes[0];
    expect(owner).toBe(boss);
    expect(spec.source).toEqual({ id: 'chapel_warden', kind: 'boss' });
    expect(spec.damage.amount).toBeCloseTo(17 * 1.35, 5);
    expect(spec.damage.type).toBe('physical');
    expect(fakes.calls.fx).toContainEqual(['shake', 0.5]);
    expect(fakes.calls.fx).toContainEqual(['hitPause', 70]);
  });

  it('chapel_slam headless fallback deals melee damage only through ctx.dealDamage', () => {
    const fakes = makeFakes({ hitboxSystem: null });
    const boss = liveBoss(wardenDef, fakes);
    const player = fakePlayerAt(640);
    boss.beginAttack('chapel_slam');
    boss.update(0.5, { x: 640, y: 240, ref: player });
    expect(fakes.calls.damage).toHaveLength(0); // still winding up
    boss.update(0.4, { x: 640, y: 240, ref: player });
    expect(fakes.calls.damage).toHaveLength(1);
    const d = fakes.calls.damage[0];
    expect(d.source).toEqual({ id: 'chapel_warden', kind: 'boss' });
    expect(d.target).toBe(player);
    expect(d.opts.amount).toBeCloseTo(17 * 1.35, 5);
  });

  it('bell_toll: radial ring of holy projectiles, hostile to the player', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    boss.takeDamage(161, {}); // phase 2
    boss.update(1.5, { x: 100, y: 240 });
    boss.beginAttack('bell_toll');
    boss.update(1.1, { x: 100, y: 240 }); // windup (1.0) elapses
    expect(fakes.calls.projectiles).toHaveLength(10);
    for (const pr of fakes.calls.projectiles) {
      expect(pr.fromPlayer).toBe(false);
      expect(pr.source).toEqual({ id: 'chapel_warden', kind: 'boss' });
      expect(pr.damage.type).toBe('holy');
      expect(pr.damage.amount).toBeCloseTo(17 * 0.85, 5);
    }
    const speeds = new Set(fakes.calls.projectiles.map((pr) => Math.hypot(pr.vx, pr.vy).toFixed(1)));
    expect(speeds.size).toBe(1); // uniform ring
  });

  it('grief_volley: aimed shadow bolts in a fan at the player', () => {
    const fakes = makeFakes();
    const boss = liveBoss(matriarchDef, fakes);
    boss.beginAttack('grief_volley');
    boss.update(1.0, { x: 100, y: 240 }); // windup (0.9) elapses
    expect(fakes.calls.projectiles).toHaveLength(4);
    for (const pr of fakes.calls.projectiles) {
      expect(pr.fromPlayer).toBe(false);
      expect(pr.source).toEqual({ id: 'sable_matriarch', kind: 'boss' });
      expect(pr.damage.type).toBe('shadow');
      // aimed leftwards toward the player (boss at x=700, player at x=100)
      expect(pr.vx).toBeLessThan(0);
    }
  });

  it('lantern_call: summons cinder_wisp minions via ctx.spawnMinion', () => {
    const fakes = makeFakes();
    const boss = liveBoss(matriarchDef, fakes);
    boss.takeDamage(900 - 594 + 1, {}); // phase 2
    boss.update(1.5, { x: 100, y: 240 });
    boss.beginAttack('lantern_call');
    boss.update(1.2, { x: 100, y: 240 }); // windup (1.1) elapses
    expect(fakes.calls.minions).toHaveLength(2);
    expect(fakes.calls.minions[0].id).toBe('cinder_wisp');
    expect(boss.minions).toHaveLength(2);
  });

  it('throne_quake: three ground shockwaves spaced across the strike', () => {
    const fakes = makeFakes();
    const boss = liveBoss(matriarchDef, fakes);
    boss.takeDamage(900 - 297 + 1, {}); // phase 3 (fraction ~0.33)
    boss.update(1.5, { x: 100, y: 240 });
    expect(boss.getPhase()).toBe(3);
    boss.beginAttack('throne_quake');
    boss.update(1.05, { x: 100, y: 240 }); // windup (1.0) elapses -> wave 1
    expect(fakes.calls.projectiles).toHaveLength(1);
    const w1 = fakes.calls.projectiles[0];
    expect(w1.vx).toBeLessThan(0); // toward the player
    expect(w1.vy).toBe(0);
    expect(w1.fromPlayer).toBe(false);
    expect(w1.source).toEqual({ id: 'sable_matriarch', kind: 'boss' });
    boss.update(0.5, { x: 100, y: 240 }); // wave 2
    expect(fakes.calls.projectiles).toHaveLength(2);
    boss.update(0.5, { x: 100, y: 240 }); // wave 3
    expect(fakes.calls.projectiles).toHaveLength(3);
  });

  it('attack cooldowns gate repeats; the fight loop picks attacks on its own', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    boss._gapT = 0;
    const p = { x: 640, y: 240, ref: fakePlayerAt(640) };
    boss.update(0.05, p); // picks chapel_slam (only attack, in range)
    expect(boss.attackId).toBe('chapel_slam');
  });
});

// -------------------------------------------------------------------- death

describe('death, rewards, and exit unlock', () => {
  it('warden death: 500 XP, moonrise_leap reward, exits unlock, state persisted', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    boss.takeDamage(9999, {});
    expect(boss.state).toBe('dying');
    expect(fakes.seen.filter(([e]) => e === 'died')).toHaveLength(0); // not yet
    boss.update(2.0, { x: 100, y: 240 }); // deathTime (1.8) elapses
    expect(boss.state).toBe('dead');
    expect(fakes.seen).toContainEqual([
      'died',
      { bossId: 'chapel_warden', roomId: 'arena_test', reward: 'moonrise_leap' },
    ]);
    expect(fakes.calls.xp).toBe(500);
    expect(fakes.calls.lockExits[fakes.calls.lockExits.length - 1]).toBe(false);
    expect(gameState.data.bossStates.chapel_warden).toBe('defeated');
  });

  it('matriarch death: 1500 XP + moonsteel_sabre into the inventory', () => {
    const fakes = makeFakes();
    const boss = liveBoss(matriarchDef, fakes);
    boss.takeDamage(9999, {});
    boss.update(2.0, { x: 100, y: 240 });
    expect(fakes.seen).toContainEqual([
      'died',
      { bossId: 'sable_matriarch', roomId: 'arena_test', reward: 'moonsteel_sabre' },
    ]);
    expect(fakes.calls.xp).toBe(1500);
    expect(fakes.calls.items).toContainEqual({ itemId: 'moonsteel_sabre', qty: 1 });
    expect(gameState.data.bossStates.sable_matriarch).toBe('defeated');
  });

  it('destroy() releases exit/camera locks even mid-fight', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    boss.destroy();
    expect(boss.destroyed).toBe(true);
    expect(fakes.calls.lockExits[fakes.calls.lockExits.length - 1]).toBe(false);
    expect(fakes.calls.cameraLock[fakes.calls.cameraLock.length - 1]).toBe(false);
  });
});

// ------------------------------------------------------- DamageSystem feed

describe('DamageSystem integration (GameScene boss-bar feed)', () => {
  it('the boss is a kind/boss target; enemy:damaged carries instanceId === bossId', () => {
    const fakes = makeFakes();
    const boss = liveBoss(wardenDef, fakes);
    const hits = [];
    const off = eventBus.on('enemy:damaged', (p) => hits.push(p));
    try {
      const res = DamageSystem.applyDamage(
        { id: 'player', kind: 'player' },
        boss,
        { amount: 50, type: 'physical', canCrit: false },
      );
      expect(res.dealt).toBe(42); // 50 - 8 flat defense
      expect(boss.getHp()).toBe(258); // 300 - 42
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ instanceId: 'chapel_warden', amount: 42, hp: 258 });
    } finally {
      off();
    }
  });

  it('combat:hitLanded fires with the boss as attacker when it hits the player', () => {
    // NOTE: dealDamage must be in ctx at construction — Boss freezes its ctx
    // defaults then, so reassigning fakes.ctx.dealDamage later has no effect.
    const fakes = makeFakes({
      hitboxSystem: null,
      dealDamage: (s, t, o) => DamageSystem.applyDamage(s, t, o),
    });
    const landed = [];
    const off = eventBus.on('combat:hitLanded', (p) => landed.push(p));
    try {
      const boss = liveBoss(wardenDef, fakes);
      const player = fakePlayerAt(640);
      boss.beginAttack('chapel_slam');
      boss.update(1.0, { x: 640, y: 240, ref: player });
      expect(landed).toHaveLength(1);
      expect(landed[0].attacker).toBe('chapel_warden');
      expect(landed[0].target).toBe('player');
    } finally {
      off();
    }
  });
});

// ------------------------------------------------------- RoomManager locks

describe('RoomManager exit lock (boss arena seal)', () => {
  it('requestExit refuses while locked and the lock releases cleanly', async () => {
    const rm = new RoomManager(null);
    const exit = { id: 'e1', x: 0, y: 0, w: 10, h: 10, target: 'other_room' };
    expect(rm.exitsLocked).toBe(false);
    rm.lockExits('boss');
    expect(rm.exitsLocked).toBe(true);
    expect(await rm.requestExit(exit)).toBe(false);
    rm.unlockExits();
    expect(rm.exitsLocked).toBe(false);
  });

  it('spawnEnemy returns null when no room is live', () => {
    const rm = new RoomManager(null);
    expect(rm.spawnEnemy('cinder_wisp', 100, 200)).toBe(null);
  });
});
