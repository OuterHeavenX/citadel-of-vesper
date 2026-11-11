/**
 * Breakables + enemies wired into combat:
 * - HitboxSystem prop registry: player swings break props (one hit per
 *   swing), enemy attacks never do, broken props are skipped.
 * - Breakable exposes id / isBroken() / getBounds() for that registry.
 * - RoomManager.init registers the enemy definitions so room enemies spawn.
 */
import { describe, it, expect, vi } from 'vitest';
import { HitboxSystem } from '../src/combat/HitboxSystem.js';
import { Breakable } from '../src/props/Breakable.js';
import { EnemyFactory } from '../src/enemies/EnemyFactory.js';
import { RoomManager } from '../src/rooms/RoomManager.js';

const DMG = { amount: 10, type: 'physical', knockback: { x: 0, y: 0 } };

function owner(kind = 'player', x = 100, y = 240) {
  return { id: kind, kind, getPosition: () => ({ x, y }), isFacingRight: () => true };
}

function swing(sys, who, spec = {}) {
  sys.spawnHitbox(who, { w: 40, h: 40, offsetX: 20, offsetY: -20, duration: 0.2, damage: DMG, ...spec });
}

describe('HitboxSystem breakable props', () => {
  it('a player swing breaks an overlapping prop once and drops its loot', () => {
    const sys = new HitboxSystem(null);
    const spawnPickup = vi.fn();
    const urn = new Breakable(null, 'urn', 115, 240, { id: 'r:brk:0', rng: () => 0, playSfx: () => {}, spawnPickup });
    sys.registerProp(urn);
    expect(sys.getPropCount()).toBe(1);
    const hit = vi.spyOn(urn, 'hit');
    swing(sys, owner());
    sys.update(0.016);
    sys.update(0.016); // same swing — hit-once
    expect(hit).toHaveBeenCalledTimes(1);
    expect(urn.isBroken()).toBe(true);
    expect(spawnPickup).toHaveBeenCalled(); // rng 0 -> every drop rolls
  });

  it('enemy attacks never break props', () => {
    const sys = new HitboxSystem(null);
    const crate = new Breakable(null, 'crate', 115, 240, { id: 'r:brk:1', playSfx: () => {} });
    sys.registerProp(crate);
    swing(sys, owner('enemy'));
    sys.update(0.016);
    expect(crate.isBroken()).toBe(false);
  });

  it('props out of reach, outside the active window, or already broken are skipped', () => {
    const sys = new HitboxSystem(null);
    const far = new Breakable(null, 'candle', 400, 240, { id: 'far', playSfx: () => {} });
    const broken = { id: 'b', hit: vi.fn(), isBroken: () => true, getBounds: () => ({ x: 110, y: 220, width: 16, height: 16 }) };
    sys.registerProp(far);
    sys.registerProp(broken);
    swing(sys, owner(), { activeFrom: 0.1 });
    sys.update(0.05); // before the active window
    swing(sys, owner());
    sys.update(0.016);
    expect(far.isBroken()).toBe(false);
    expect(broken.hit).not.toHaveBeenCalled();
  });

  it('unregisterProp / shutdown remove props', () => {
    const sys = new HitboxSystem(null);
    const p = { id: 'p', hit: vi.fn() };
    sys.registerProp(p);
    sys.unregisterProp(p);
    expect(sys.getPropCount()).toBe(0);
    sys.registerProp(p);
    sys.shutdown();
    expect(sys.getPropCount()).toBe(0);
  });

  it('a prop error never breaks combat', () => {
    const sys = new HitboxSystem(null);
    sys.registerProp({ id: 'bad', hit: () => { throw new Error('boom'); }, getBounds: () => ({ x: 110, y: 220, width: 16, height: 16 }) });
    swing(sys, owner());
    expect(() => sys.update(0.016)).not.toThrow();
  });
});

describe('Breakable hit surface', () => {
  it('has an id, a feet-anchored fallback box and isBroken()', () => {
    const b = new Breakable(null, 'urn', 50, 240, { id: 'room:brk:3', playSfx: () => {} });
    expect(b.id).toBe('room:brk:3');
    expect(b.getBounds()).toEqual({ x: 42, y: 224, width: 16, height: 16 }); // sits on y
    expect(b.isBroken()).toBe(false);
    b.hit();
    expect(b.isBroken()).toBe(true);
    expect(b.hit()).toBe(false); // no double break
  });

  it('defaults a unique-ish id when none is given', () => {
    expect(new Breakable(null, 'crate', 1, 2).id).toBe('breakable:crate:1:2');
  });
});

describe('RoomManager registers enemy definitions', () => {
  it('init() makes every data/enemies.json id creatable', async () => {
    EnemyFactory.defs = null;
    const rm = new RoomManager(null);
    rm.init({ hitboxSystem: null, projectileSystem: null });
    const { readFileSync } = await import('node:fs');
    const enemies = JSON.parse(readFileSync(new URL('../data/enemies.json', import.meta.url), 'utf8'));
    for (const e of enemies) expect(EnemyFactory.defs.has(e.id), e.id).toBe(true);
    const hound = EnemyFactory.create('ash_hound', null, 100, 240, 'test:0', {});
    expect(hound.def.id).toBe('ash_hound');
  });
});

describe('room data: ground props rest on a floor', () => {
  it('every candle / urn / crate y is a floor or platform surface', async () => {
    const { readFileSync } = await import('node:fs');
    const rooms = JSON.parse(readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'));
    for (const r of rooms) {
      const g = r.geometry ?? {};
      const surfaces = new Set([...(g.solids ?? []), ...(g.oneway ?? [])].map((s) => s.y));
      for (const b of r.breakables ?? []) {
        if (b.kind === 'chandelier') continue;
        expect(surfaces.has(b.y), `${r.id} ${b.kind}@${b.x},${b.y}`).toBe(true);
      }
    }
  });
});
