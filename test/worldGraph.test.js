/**
 * WorldGraph unit + data-driven tests (spec §24, §28, §54).
 *
 * Unit fixtures exercise the graph API in isolation; the data-driven
 * section runs the same validators over data/rooms.json so CI tests and
 * scripts/validate.js agree.
 */
import { describe, expect, it } from 'vitest';
import {
  WorldGraph,
  buildGraph,
  validateWorld,
  findPath,
  reachableFrom,
  START_ROOM_ID,
} from '../src/world/WorldGraph.js';
import { loadJson } from './helpers.js';

const rooms = loadJson('data/rooms.json');
const abilities = loadJson('data/abilities.json');
const bosses = loadJson('data/bosses.json');
const ALL_ABILITIES = abilities.map((a) => a.id);

/** Miniature world: hall<->start, vault gated behind moonrise_leap, crypt hidden below hall. */
function fixtureRooms() {
  return [
    {
      id: 'start', region: 'moonlit_gate', name: 'Start', width: 960, height: 270,
      map: { x: 0, y: 0 },
      exits: [
        { id: 'e1', dir: 'east', x: 948, y: 180, w: 12, h: 70, target: 'hall', spawn: { x: 30, y: 210 } },
      ],
    },
    {
      id: 'hall', region: 'moonlit_gate', name: 'Hall', width: 960, height: 270,
      map: { x: 1, y: 0 },
      exits: [
        { id: 'w1', dir: 'west', x: 0, y: 180, w: 12, h: 70, target: 'start', spawn: { x: 930, y: 210 } },
        { id: 'e2', dir: 'east', x: 948, y: 180, w: 12, h: 70, target: 'vault', spawn: { x: 30, y: 210 }, requires: ['moonrise_leap'] },
        { id: 'd1', dir: 'down', x: 480, y: 260, w: 40, h: 10, target: 'crypt', spawn: { x: 480, y: 30 } },
      ],
    },
    {
      id: 'vault', region: 'moonlit_gate', name: 'Vault', width: 960, height: 270,
      map: { x: 2, y: 0 }, saveRoom: true,
      exits: [
        { id: 'w2', dir: 'west', x: 0, y: 180, w: 12, h: 70, target: 'hall', spawn: { x: 930, y: 210 } },
      ],
    },
    {
      id: 'crypt', region: 'hollow_keep', name: 'Crypt', width: 960, height: 270,
      map: { x: 1, y: 1 }, hidden: true,
      secrets: [
        { id: 's1', kind: 'breakable_wall', x: 700, y: 150, w: 32, h: 90, reward: { abilityId: 'moonrise_leap' } },
      ],
      exits: [
        { id: 'u1', dir: 'up', x: 480, y: 0, w: 40, h: 10, target: 'hall', spawn: { x: 480, y: 250 } },
      ],
    },
  ];
}

describe('WorldGraph unit', () => {
  it('buildGraph creates nodes and gated edges', () => {
    const g = buildGraph(fixtureRooms());
    expect(g).toBeInstanceOf(WorldGraph);
    expect(g.nodes.size).toBe(4);
    const gated = g.adj.get('hall').find((e) => e.to === 'vault');
    expect(gated.requires).toEqual(['moonrise_leap']);
  });

  it('findPath honors ability gates', () => {
    expect(findPath(fixtureRooms(), 'start', 'vault', [])).toBeNull();
    expect(findPath(fixtureRooms(), 'start', 'vault', ['moonrise_leap'])).toEqual([
      'start', 'hall', 'vault',
    ]);
  });

  it('findPath returns null for unknown rooms and the trivial path', () => {
    expect(findPath(fixtureRooms(), 'start', 'nope', [])).toBeNull();
    expect(findPath(fixtureRooms(), 'start', 'start', [])).toEqual(['start']);
  });

  it('reachableFrom respects gates', () => {
    const none = reachableFrom(fixtureRooms(), 'start', []);
    expect([...none].sort()).toEqual(['crypt', 'hall', 'start']);
    const all = reachableFrom(fixtureRooms(), 'start', ['moonrise_leap']);
    expect([...all].sort()).toEqual(['crypt', 'hall', 'start', 'vault']);
  });

  it('reachableWithCollection collects abilities granted by reachable rooms', () => {
    const g = buildGraph(fixtureRooms());
    const { reachable, abilities: got } = g.reachableWithCollection('start', new Map());
    // crypt (hidden below hall) grants moonrise_leap -> vault opens
    expect(got.has('moonrise_leap')).toBe(true);
    expect([...reachable].sort()).toEqual(['crypt', 'hall', 'start', 'vault']);
  });

  it('validateWorld is clean on the fixture', () => {
    const { errors } = validateWorld(fixtureRooms(), {
      startRoomId: 'start',
      abilities: ['moonrise_leap'],
      bosses: [{ id: 'warden', arenaRoomId: 'vault' }],
    });
    expect(errors).toEqual([]);
  });

  it('validateWorld warns when a boss arena is not in rooms.json yet', () => {
    const { errors, warnings } = validateWorld(fixtureRooms(), {
      startRoomId: 'start',
      abilities: ['moonrise_leap'],
      bosses: [{ id: 'matriarch', arenaRoomId: 'future_arena' }],
    });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('matriarch') && w.includes('not in rooms.json'))).toBe(true);
  });

  it('validateWorld errors on a dangling exit target', () => {
    const rs = fixtureRooms();
    rs[0].exits[0].target = 'ghost_room';
    const { errors } = validateWorld(rs, { startRoomId: 'start' });
    expect(errors.some((e) => e.includes('ghost_room'))).toBe(true);
  });

  it('validateWorld errors on an unreachable room and on cell collisions', () => {
    const rs = fixtureRooms();
    rs.push({
      id: 'limbo', region: 'moonlit_gate', name: 'Limbo', width: 960, height: 270,
      map: { x: 0, y: 0 }, // collides with 'start'
      exits: [],
    });
    const { errors } = validateWorld(rs, { startRoomId: 'start', abilities: ['moonrise_leap'] });
    expect(errors.some((e) => e.includes('limbo') && e.includes('unreachable'))).toBe(true);
    expect(errors.some((e) => e.includes('already used'))).toBe(true);
  });

  it('validateWorld errors on unknown ability in requires', () => {
    const rs = fixtureRooms();
    rs[1].exits[1].requires = ['not_a_real_ability'];
    const { errors } = validateWorld(rs, { startRoomId: 'start', abilities: ['moonrise_leap'] });
    expect(errors.some((e) => e.includes('not_a_real_ability'))).toBe(true);
  });

  it('validateWorld warns on one-way traps and dead-ends (no-softlock check)', () => {
    const rs = fixtureRooms();
    rs.push({
      id: 'pit', region: 'hollow_keep', name: 'Pit', width: 960, height: 270,
      map: { x: 3, y: 0 },
      exits: [
        { id: 'deeper', dir: 'down', x: 480, y: 260, w: 40, h: 10, target: 'dead', spawn: { x: 480, y: 30 } },
      ],
    });
    rs.push({
      id: 'dead', region: 'hollow_keep', name: 'Dead End', width: 960, height: 270,
      map: { x: 3, y: 1 },
      exits: [],
    });
    // make 'hall' drop one-way into 'pit' with no way back to start
    rs[1].exits.push({
      id: 'drop', dir: 'down', x: 200, y: 260, w: 40, h: 10, target: 'pit', spawn: { x: 200, y: 30 },
    });
    const { warnings } = validateWorld(rs, { startRoomId: 'start', abilities: ['moonrise_leap'] });
    expect(warnings.some((w) => w.includes('pit') && w.includes('one-way trap'))).toBe(true);
    expect(warnings.some((w) => w.includes('dead') && w.includes('dead-end'))).toBe(true);
  });

  it('validateWorld exempts save rooms and teleport chambers from the trap check', () => {
    const rs = fixtureRooms();
    rs.push({
      id: 'shrine', region: 'hollow_keep', name: 'Shrine', width: 960, height: 270,
      map: { x: 3, y: 0 }, saveRoom: true,
      exits: [],
    });
    const { warnings } = validateWorld(rs, { startRoomId: 'start', abilities: ['moonrise_leap'] });
    // 'shrine' is unreachable from start, so it errors — but must NOT be a trap warning
    expect(warnings.some((w) => w.includes('shrine') && w.includes('trap'))).toBe(false);
  });
});

describe('world connectivity (data-driven)', () => {
  it('validateWorld reports no errors on data/rooms.json', () => {
    const { errors } = validateWorld(rooms, {
      abilities: ALL_ABILITIES,
      bosses,
    });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('every room is reachable from the start with no abilities AND with all abilities', () => {
    const g = buildGraph(rooms);
    const reachNone = g.reachableFrom(START_ROOM_ID, []);
    const reachAll = g.reachableFrom(START_ROOM_ID, ALL_ABILITIES);
    const { reachable: reachCollected } = g.reachableWithCollection(
      START_ROOM_ID,
      new Map(bosses.map((b) => [b.arenaRoomId, b])),
    );
    for (const room of rooms) {
      const viaCollected = reachCollected.has(room.id);
      const viaAll = reachAll.has(room.id);
      expect(
        viaCollected || viaAll,
        `${room.id}: unreachable from ${START_ROOM_ID} (fixpoint + full-ability)`,
      ).toBe(true);
      if (!reachNone.has(room.id)) {
        // ability-gated rooms are legal — they just need SOME ability path
        expect(viaCollected, `${room.id}: behind a gate but uncollectable`).toBe(true);
      }
    }
  });

  it('every boss arena present in rooms.json is reachable with the expected ability set', () => {
    const g = buildGraph(rooms);
    const { reachable: reachCollected } = g.reachableWithCollection(
      START_ROOM_ID,
      new Map(bosses.map((b) => [b.arenaRoomId, b])),
    );
    const roomIds = new Set(rooms.map((r) => r.id));
    for (const boss of bosses) {
      if (!boss.arenaRoomId || !roomIds.has(boss.arenaRoomId)) continue; // later wave: warning, not error
      expect(
        reachCollected.has(boss.arenaRoomId),
        `boss ${boss.id}: arena ${boss.arenaRoomId} unreachable with collected abilities`,
      ).toBe(true);
    }
  });

  it('no softlocks: every non-arena room has a path back to start (all abilities)', () => {
    const g = buildGraph(rooms);
    const arenaIds = new Set(
      bosses.map((b) => b.arenaRoomId).filter((id) => g.nodes.has(id)),
    );
    const traps = [];
    for (const room of rooms) {
      if (arenaIds.has(room.id)) continue;
      if (room.saveRoom === true || room.teleport === true) continue;
      if (g.findPath(room.id, START_ROOM_ID, ALL_ABILITIES) === null) {
        traps.push(room.id);
      }
    }
    expect(traps, `one-way traps with no path back to ${START_ROOM_ID}: ${traps.join(', ')}`).toEqual([]);
  });

  it('map grid cells are unique across all rooms', () => {
    const cells = new Map();
    for (const room of rooms) {
      const key = `${room.map.x},${room.map.y}`;
      expect(cells.has(key), `${room.id} collides on map cell ${key}`).toBe(false);
      cells.set(key, room.id);
    }
  });
});
