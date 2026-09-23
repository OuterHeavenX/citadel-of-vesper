/**
 * HitboxSystem unit tests — active-window gating, hit-once, facing mirror.
 * Phaser-free: fake owner/entities only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HitboxSystem } from '../src/combat/HitboxSystem.js';

function makeOwner(x = 100, y = 100, facingRight = true) {
  return {
    id: 'player',
    kind: 'player',
    getPosition: () => ({ x, y }),
    isFacingRight: () => facingRight,
  };
}

function makeEnemy(id, x, y, w = 20, h = 20) {
  return {
    id,
    kind: 'enemy',
    takeDamage: vi.fn(),
    getDefense: () => 0,
    isInvulnerable: () => false,
    getBounds: () => ({ x: x - w / 2, y: y - h / 2, width: w, height: h }),
  };
}

const DMG = { amount: 10, type: 'physical', knockback: { x: 0, y: 0 } };

describe('HitboxSystem', () => {
  let sys;
  let owner;

  beforeEach(() => {
    sys = new HitboxSystem(null);
    owner = makeOwner();
  });

  it('deals damage ONLY inside [activeFrom, activeTo]', () => {
    const e = makeEnemy('e1', 120, 100);
    sys.registerHurtbox(e);
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.3, activeFrom: 0.1, activeTo: 0.2,
      damage: DMG, hitOnce: false,
      source: { id: 'player', kind: 'player' },
    });

    sys.update(0.05); // elapsed 0.05 — anticipation
    expect(e.takeDamage).not.toHaveBeenCalled();

    sys.update(0.06); // elapsed 0.11 — active
    expect(e.takeDamage).toHaveBeenCalledTimes(1);
    expect(e.takeDamage.mock.calls[0][0]).toBe(10);
    expect(e.takeDamage.mock.calls[0][1].source).toEqual({ id: 'player', kind: 'player' });

    sys.update(0.05); // elapsed 0.16 — still active, hitOnce:false hits again
    expect(e.takeDamage).toHaveBeenCalledTimes(2);

    sys.update(0.2); // elapsed 0.36 — past duration, despawned
    expect(e.takeDamage).toHaveBeenCalledTimes(2);
    expect(sys.getHitboxCount()).toBe(0);
  });

  it('hitOnce (default) hits each (hitbox,target) pair at most once', () => {
    const e = makeEnemy('e1', 120, 100);
    sys.registerHurtbox(e);
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.5, activeFrom: 0, activeTo: 0.4,
      damage: DMG,
      source: { id: 'player', kind: 'player' },
    });
    for (let i = 0; i < 10; i++) sys.update(0.05);
    expect(e.takeDamage).toHaveBeenCalledTimes(1);
  });

  it('never damages its owner', () => {
    sys.registerHurtbox(owner, { w: 20, h: 40 });
    owner.takeDamage = vi.fn();
    owner.getDefense = () => 0;
    owner.isInvulnerable = () => false;
    owner.getBounds = () => ({ x: 90, y: 80, width: 20, height: 40 });
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.3, activeFrom: 0, activeTo: 0.3,
      damage: DMG,
    });
    sys.update(0.1);
    expect(owner.takeDamage).not.toHaveBeenCalled();
  });

  it('mirrors the hitbox with owner facing', () => {
    const right = makeEnemy('er', 120, 100);
    const left = makeEnemy('el', 80, 100);
    sys.registerHurtbox(right);
    sys.registerHurtbox(left);

    // Facing right: hits the right enemy only.
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.2, activeFrom: 0, activeTo: 0.2,
      damage: DMG, source: { id: 'player', kind: 'player' },
    });
    sys.update(0.1);
    expect(right.takeDamage).toHaveBeenCalledTimes(1);
    expect(left.takeDamage).not.toHaveBeenCalled();

    // Facing left: hits the left enemy only.
    const ownerL = makeOwner(100, 100, false);
    sys.spawnHitbox(ownerL, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.2, activeFrom: 0, activeTo: 0.2,
      damage: DMG, source: { id: 'player', kind: 'player' },
    });
    sys.update(0.1);
    expect(left.takeDamage).toHaveBeenCalledTimes(1);
    expect(right.takeDamage).toHaveBeenCalledTimes(1); // hit-once per hitbox
  });

  it('despawnHitbox cancels a hitbox early', () => {
    const e = makeEnemy('e1', 120, 100);
    sys.registerHurtbox(e);
    const id = sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.5, activeFrom: 0, activeTo: 0.5,
      damage: DMG, hitOnce: false, source: { id: 'player', kind: 'player' },
    });
    sys.update(0.1);
    expect(e.takeDamage).toHaveBeenCalledTimes(1);
    sys.despawnHitbox(id);
    sys.update(0.1);
    expect(e.takeDamage).toHaveBeenCalledTimes(1);
    expect(sys.getHitboxCount()).toBe(0);
  });

  it('falls back to the registered box when the entity has no getBounds', () => {
    const e = {
      id: 'e2', kind: 'enemy', x: 120, y: 100,
      takeDamage: vi.fn(), getDefense: () => 0, isInvulnerable: () => false,
    };
    sys.registerHurtbox(e, { w: 20, h: 20, offsetX: 0, offsetY: 0 });
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.2, activeFrom: 0, activeTo: 0.2,
      damage: DMG, source: { id: 'player', kind: 'player' },
    });
    sys.update(0.1);
    expect(e.takeDamage).toHaveBeenCalledTimes(1);
  });

  it('unregisterHurtbox removes the target', () => {
    const e = makeEnemy('e1', 120, 100);
    sys.registerHurtbox(e);
    sys.unregisterHurtbox(e);
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.2, activeFrom: 0, activeTo: 0.2,
      damage: DMG, source: { id: 'player', kind: 'player' },
    });
    sys.update(0.1);
    expect(e.takeDamage).not.toHaveBeenCalled();
  });

  it('drawDebug renders without a real Phaser graphics object', () => {
    const e = makeEnemy('e1', 120, 100);
    sys.registerHurtbox(e);
    sys.spawnHitbox(owner, {
      w: 36, h: 26, offsetX: 17, offsetY: 0,
      duration: 0.3, activeFrom: 0.1, activeTo: 0.2,
      damage: DMG,
    });
    const graphics = { lineStyle: vi.fn(), strokeRect: vi.fn() };
    expect(() => sys.drawDebug(graphics)).not.toThrow();
    expect(graphics.strokeRect).toHaveBeenCalled();
    expect(() => sys.drawDebug(null)).not.toThrow();
  });
});
