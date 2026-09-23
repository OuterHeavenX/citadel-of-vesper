/**
 * test/roomManager.test.js — Wave 3 room streaming (W3-ROOMS).
 *
 * Covers the headless-feasible parts of RoomManager:
 * - checkExitGate: open / ability-gated / item-gated exits (+ custom hints)
 * - resolveSpawn: spawnHint > playerStart > default
 * - getRoomDef / getAdjacentRoomIds against the real rooms.json
 * - requestExit: blocked exits never reach transitionThrough; open exits do
 * - transitionThrough: sets `via`, resets the transition lock
 * - isSecretFound: reads the gameState secret flag
 *
 * Full Phaser builds (tilemap painting, zones, fades) are not headless-
 * feasible and are covered by npm run validate + browser QA instead.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RoomManager,
  checkExitGate,
  resolveSpawn,
} from '../src/rooms/RoomManager.js';
import { secretFlag } from '../src/rooms/Room.js';

function makeDeps(over = {}) {
  const flags = new Map();
  const gs = {
    data: {
      inventory: over.inventory ?? [],
      player: { abilities: over.abilities ?? [] },
      teleports: [],
      map: { discovered: [] },
    },
    getFlag: (f) => flags.get(f) ?? null,
    setFlag: (f, v) => flags.set(f, v),
    discoverRoom: vi.fn(),
    discoverTeleport: vi.fn(),
    _flags: flags,
  };
  const am = { has: (id) => (over.abilities ?? []).includes(id) };
  return { gameState: gs, abilityManager: am };
}

const openExit = {
  id: 'e_open', dir: 'east', x: 944, y: 170, w: 16, h: 80,
  target: 'moonlit_gate_002', spawn: { x: 30, y: 236 },
};

describe('checkExitGate', () => {
  const gates = {
    hasAbility: (id) => id === 'moonrise_leap',
    hasItem: (id) => id === 'moonstone_charm',
  };

  it('allows an ungated exit', () => {
    expect(checkExitGate(openExit, gates)).toMatchObject({ ok: true, blockedBy: null });
  });

  it('blocks when a required ability is missing', () => {
    const exit = { ...openExit, requires: ['gale_dash'] };
    const res = checkExitGate(exit, gates);
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe('ability');
    expect(res.missing).toEqual(['gale_dash']);
  });

  it('allows when all required abilities are held', () => {
    const exit = { ...openExit, requires: ['moonrise_leap'] };
    expect(checkExitGate(exit, gates).ok).toBe(true);
  });

  it('blocks when the key item is missing', () => {
    const exit = { ...openExit, requiresItem: 'rusted_crown' };
    const res = checkExitGate(exit, gates);
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe('item');
    expect(res.missing).toEqual(['rusted_crown']);
    expect(res.hint).toContain('key item');
  });

  it('allows when the key item is carried', () => {
    const exit = { ...openExit, requiresItem: 'moonstone_charm' };
    expect(checkExitGate(exit, gates).ok).toBe(true);
  });

  it('prefers the exit hint text over the generic message', () => {
    const exit = { ...openExit, requires: ['gale_dash'], hint: 'Custom hint.' };
    expect(checkExitGate(exit, gates).hint).toBe('Custom hint.');
  });
});

describe('resolveSpawn', () => {
  it('prefers the explicit spawnHint', () => {
    const def = { playerStart: { x: 1, y: 2 } };
    expect(resolveSpawn(def, { x: 10, y: 20, facing: -1 })).toEqual({ x: 10, y: 20, facing: -1 });
  });

  it('falls back to playerStart', () => {
    const def = { playerStart: { x: 120, y: 236, facing: 1 } };
    expect(resolveSpawn(def, null)).toEqual({ x: 120, y: 236, facing: 1 });
  });

  it('falls back to a safe default', () => {
    expect(resolveSpawn({}, null)).toEqual({ x: 60, y: 200, facing: 1 });
  });
});

describe('RoomManager queries (real rooms.json)', () => {
  const rm = new RoomManager(null);

  it('getRoomDef returns the room and throws on unknown ids', () => {
    const def = rm.getRoomDef('moonlit_gate_001');
    expect(def.name).toBe('Moonlit Threshold');
    expect(() => rm.getRoomDef('nope_not_a_room')).toThrow(/unknown room id/);
  });

  it('getAdjacentRoomIds lists unique targets', () => {
    rm.currentRoomId = 'moonlit_gate_002';
    expect(rm.getAdjacentRoomIds().sort()).toEqual(
      ['moonlit_gate_001', 'moonlit_gate_003', 'moonlit_gate_004'].sort(),
    );
  });

  it('the boss arena ids from bosses.json exist', async () => {
    const { default: bosses } = await import('../data/bosses.json');
    for (const b of bosses) {
      expect(() => rm.getRoomDef(b.arenaRoomId)).not.toThrow();
    }
  });

  it('every exit target resolves (mirrors validate.js)', async () => {
    const { default: rooms } = await import('../data/rooms.json');
    for (const r of rooms) {
      for (const e of r.exits) {
        expect(() => rm.getRoomDef(e.target), `${r.id}:${e.id}`).not.toThrow();
      }
    }
  });
});

describe('requestExit / transitionThrough', () => {
  function makeRm(over = {}) {
    const deps = makeDeps(over);
    const rm = new RoomManager(null, deps);
    rm.init({ hitboxSystem: null, projectileSystem: null });
    return { rm, deps };
  }

  it('blocked exits never reach transitionThrough', async () => {
    const { rm } = makeRm({ abilities: [] });
    const spy = vi.spyOn(rm, 'transitionThrough');
    const exit = { ...openExit, requires: ['moonrise_leap'], hint: 'Too high.' };
    const started = await rm.requestExit(exit);
    expect(started).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(rm.isTransitioning).toBe(false);
  });

  it('open exits start a transition', async () => {
    const { rm } = makeRm({});
    const spy = vi.spyOn(rm, 'transitionThrough').mockResolvedValue(true);
    const started = await rm.requestExit(openExit);
    expect(started).toBe(true);
    expect(spy).toHaveBeenCalledWith(openExit);
  });

  it('concurrent transitions are rejected', async () => {
    const { rm } = makeRm({});
    rm._transitioning = true;
    expect(await rm.requestExit(openExit)).toBe(false);
    expect(await rm.transitionThrough(openExit)).toBe(false);
    rm._transitioning = false;
  });

  it('transitionThrough records via and resets the lock (stubbed loadRoom)', async () => {
    const { rm } = makeRm({});
    const seen = [];
    rm.loadRoom = async (id, spawn) => { seen.push([id, spawn]); };
    const ok = await rm.transitionThrough(openExit);
    expect(ok).toBe(true);
    expect(seen).toEqual([['moonlit_gate_002', openExit.spawn]]);
    expect(rm.isTransitioning).toBe(false);
    // `via` is consumed by the room:changed payload on the next loadRoom.
    expect(rm._lastVia).toBe('e_open');
  });
});

describe('secrets', () => {
  it('secretFlag namespaces gameState flags', () => {
    expect(secretFlag('mg005_ember_hollow')).toBe('secret:mg005_ember_hollow');
  });

  it('isSecretFound reads the flag', () => {
    const deps = makeDeps({});
    const rm = new RoomManager(null, deps);
    expect(rm.isSecretFound('mg005_ember_hollow')).toBe(false);
    deps.gameState.setFlag(secretFlag('mg005_ember_hollow'), true);
    expect(rm.isSecretFound('mg005_ember_hollow')).toBe(true);
  });
});
