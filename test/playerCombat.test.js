/**
 * PlayerCombat unit tests — data-driven phases, buffering, hitbox spawn,
 * i-frames, hit reactions. Fake facade + fake HitboxSystem; real gameState.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerCombat } from '../src/player/PlayerCombat.js';
import { gameState } from '../src/core/GameState.js';
import { tuning } from '../src/config/tuning.js';
import { eventBus } from '../src/core/EventBus.js';

function makePlayer() {
  return {
    id: 'player',
    kind: 'player',
    _facing: true,
    _stats: {
      physicalAttack: 10, attackSpeed: 1, critChance: 0,
      defense: 0, magicDefense: 0, resistances: {},
    },
    getSprite: () => null,
    isFacingRight() { return this._facing; },
    getState: () => 'idle',
    getStats() { return this._stats; },
    getPosition: () => ({ x: 100, y: 100 }),
    // Facade damage entry (integration contract): applies HP loss itself.
    takeDamage: vi.fn(function (amount) {
      gameState.data.player.hp = Math.max(0, gameState.data.player.hp - amount);
      this._invuln = true;
      if (gameState.data.player.hp <= 0) {
        eventBus.emit('player:died', { roomId: 'moonlit_gate_001' });
      }
      return amount;
    }),
    isInvulnerable() { return !!this._invuln; },
    isDead() { return gameState.data.player.hp <= 0; },
  };
}

function makeHitboxes() {
  return { spawnHitbox: vi.fn(() => 'hb_1'), despawnHitbox: vi.fn() };
}

// recruit_blade: anticipation 0.06, activeFrames 2 @12fps, recovery 0.32
const ACTIVE = 2 / 12;

describe('PlayerCombat', () => {
  let player;
  let hitboxes;
  let combat;

  beforeEach(() => {
    eventBus.clear();
    player = makePlayer();
    hitboxes = makeHitboxes();
    combat = new PlayerCombat(player, { hitboxSystem: hitboxes });
    gameState.data.player.hp = 60;
    gameState.unequip('weapon');
  });

  afterEach(() => {
    eventBus.clear();
    gameState.data.player.hp = 60;
    gameState.unequip('weapon');
  });

  it('runs anticipation -> active -> recovery -> idle with data-driven timing', () => {
    expect(combat.tryAttack()).toBe(true);
    expect(combat.getPhase()).toBe('anticipation');
    expect(combat.isAttacking()).toBe(true);

    combat.update(0.05);
    expect(combat.getPhase()).toBe('anticipation');
    expect(hitboxes.spawnHitbox).not.toHaveBeenCalled();

    combat.update(0.01); // t=0.06 -> active
    expect(combat.getPhase()).toBe('active');
    expect(hitboxes.spawnHitbox).toHaveBeenCalledTimes(1);

    combat.update(ACTIVE); // past active window -> recovery
    expect(combat.getPhase()).toBe('recovery');

    combat.update(0.33); // past recovery -> idle
    expect(combat.getPhase()).toBe('idle');
    expect(combat.isAttacking()).toBe(false);
  });

  it('spawns the hitbox from the weapon profile (reach-derived offset)', () => {
    combat.tryAttack();
    combat.update(0.06);
    const [owner, spec] = hitboxes.spawnHitbox.mock.calls[0];
    expect(owner).toBe(player);
    expect(spec.w).toBe(36);
    expect(spec.h).toBe(26);
    expect(spec.offsetX).toBeCloseTo(34 * 0.5, 5); // reach/2 ahead, mirrored by facing
    expect(spec.activeFrom).toBe(0);
    expect(spec.activeTo).toBeCloseTo(ACTIVE, 5);
    expect(spec.hitOnce).toBe(true);
    expect(spec.source).toEqual({ id: 'player', kind: 'player' });
    expect(spec.damage.amount).toBe(10); // stats.physicalAttack
    expect(spec.damage.type).toBe('physical');
    expect(spec.damage.knockback.x).toBe(120); // profile knockback, facing right
    expect(spec.damage.canCrit).toBe(true);
  });

  it('mirrors knockback when facing left', () => {
    player._facing = false;
    combat.tryAttack();
    combat.update(0.06);
    const spec = hitboxes.spawnHitbox.mock.calls[0][1];
    expect(spec.damage.knockback.x).toBe(-120);
  });

  it('buffers attacks and chains on completion', () => {
    combat.tryAttack();
    combat.update(0.06); // active
    expect(hitboxes.spawnHitbox).toHaveBeenCalledTimes(1);
    combat.update(ACTIVE + 0.2); // deep into recovery (0.32s total)
    expect(combat.getPhase()).toBe('recovery');
    combat.tryAttack(); // buffered — 0.15s window at the tail of the attack
    combat.update(0.13); // recovery ends -> chained attack starts
    expect(combat.getPhase()).toBe('anticipation');
    combat.update(0.06);
    expect(combat.getPhase()).toBe('active');
    expect(hitboxes.spawnHitbox).toHaveBeenCalledTimes(2);
  });

  it('drops the buffer when it expires before the attack ends', () => {
    combat.tryAttack();
    combat.tryAttack(); // buffer 0.15s at attack start; attack lasts ~0.55s
    // Burn the whole attack without letting the buffer fire early:
    // buffer decays during the attack; attack total ~0.55s > 0.15s.
    combat.update(0.06 + ACTIVE + 0.32 + 0.01);
    expect(combat.getPhase()).toBe('idle');
    expect(hitboxes.spawnHitbox).toHaveBeenCalledTimes(1);
  });

  it('cancelOnHit despawns the hitbox and returns to idle', () => {
    combat.tryAttack();
    combat.update(0.06);
    combat.cancelOnHit();
    expect(combat.getPhase()).toBe('idle');
    expect(hitboxes.despawnHitbox).toHaveBeenCalledWith('hb_1');
  });

  it('takeDamage delegates to the facade and interrupts the swing', () => {
    const died = [];
    eventBus.on('player:died', (p) => died.push(p));

    combat.tryAttack();
    combat.update(0.06);
    expect(combat.isAttacking()).toBe(true);

    const ret = combat.takeDamage(10, {
      source: { id: 'ghoul_1', kind: 'enemy' },
      knockback: { x: -80, y: 0 },
      hitStun: 0.2,
    });
    expect(ret.killed).toBe(false);
    expect(player.takeDamage).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ hitStun: 0.2 }),
    );
    expect(gameState.data.player.hp).toBe(50); // facade applied the loss
    expect(combat.isAttacking()).toBe(false); // swing interrupted
    expect(combat.isInvulnerable()).toBe(true); // facade i-frames

    combat.takeDamage(50, {});
    expect(combat.isDead()).toBe(true);
    expect(died).toHaveLength(1);
    expect(died[0]).toEqual({ roomId: 'moonlit_gate_001' });
  });

  it('getDefense prefers resistances, falls back to a diminishing flat curve', () => {
    player._stats.resistances = { physical: 0.25 };
    expect(combat.getDefense('physical')).toBe(0.25);
    expect(combat.getDefense('fire')).toBe(0); // no resistance, no flat

    player._stats.resistances = {};
    player._stats.defense = 50;
    expect(combat.getDefense('physical')).toBeCloseTo(0.5, 5); // 50/(50+50)
    player._stats.magicDefense = 150;
    expect(combat.getDefense('fire')).toBeCloseTo(0.75, 5);
  });

  it('getActiveProfile follows live weapon switches', () => {
    expect(combat.getActiveProfile().weaponId).toBe('recruit_blade');
    gameState.equip('weapon', 'moonsteel_sabre');
    const prof = combat.getActiveProfile();
    expect(prof.weaponId).toBe('moonsteel_sabre');
    expect(prof.family).toBe('sword');
    expect(prof.profile.reach).toBe(40);
    expect(prof.profile.attackSpeed).toBe(1.25);
    expect(prof.specials).toHaveLength(1);
  });

  it('trySecondary is a reserved no-op until the Wave 4 special system', () => {
    expect(combat.trySecondary()).toBe(false);
  });

  it('accepts getStats() returning the PlayerStats instance shape', () => {
    player.getStats = () => ({
      getDerived: () => ({
        physicalAttack: 25, attackSpeed: 2, critChance: 0.5, resistances: {},
      }),
      getDefense: (type) => (type === 'physical' ? 0.3 : 0),
    });
    expect(combat.getDefense('physical')).toBe(0.3); // delegated to PlayerStats
    expect(combat.getDefense('fire')).toBe(0);
    combat.tryAttack();
    combat.update(0.06);
    const spec = hitboxes.spawnHitbox.mock.calls[0][1];
    expect(spec.damage.amount).toBe(25);
    expect(spec.damage.critChance).toBe(0.5);
  });

  it('exposes DamageSystem target identity', () => {
    expect(combat.id).toBe('player');
    expect(combat.kind).toBe('player');
    expect(combat.getMaxHp()).toBe(60);
  });
});
