/**
 * MapModel tests (spec §27): completion %, discovery, markers, secrets.
 * The model is Phaser-free; discovery mutations route through
 * gameState.discoverRoom().
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MapModel } from '../src/map/MapModel.js';
import { gameState } from '../src/core/GameState.js';

function fixtureRooms() {
  return [
    {
      id: 'r1', region: 'moonlit_gate', name: 'Gate', width: 960, height: 270,
      map: { x: 0, y: 0 }, saveRoom: true,
      exits: [
        { id: 'e1', dir: 'east', x: 948, y: 180, w: 12, h: 70, target: 'r2', spawn: { x: 30, y: 210 } },
      ],
    },
    {
      id: 'r2', region: 'moonlit_gate', name: 'Hall', width: 960, height: 270,
      map: { x: 1, y: 0 }, teleport: true,
      exits: [
        { id: 'w1', dir: 'west', x: 0, y: 180, w: 12, h: 70, target: 'r1', spawn: { x: 930, y: 210 } },
        { id: 'd1', dir: 'down', x: 480, y: 260, w: 40, h: 10, target: 'r3', spawn: { x: 480, y: 30 } },
      ],
    },
    {
      id: 'r3', region: 'moonlit_gate', name: 'Cache', width: 960, height: 270,
      map: { x: 1, y: 1 }, hidden: true,
      exits: [
        { id: 'u1', dir: 'up', x: 480, y: 0, w: 40, h: 10, target: 'r2', spawn: { x: 480, y: 250 } },
      ],
    },
  ];
}

const BOSSES = [{ id: 'warden', arenaRoomId: 'r2' }];

beforeEach(() => {
  gameState.reset();
});

describe('MapModel', () => {
  it('getCompletion counts only non-secret rooms', () => {
    const m = new MapModel(fixtureRooms());
    expect(m.getCompletion()).toBe(0);
    m.discover('r1');
    expect(m.getCompletion()).toBe(50);
    m.discover('r2');
    expect(m.getCompletion()).toBe(100);
    m.discover('r3'); // hidden: discovered, but never counts
    expect(m.getCompletion()).toBe(100);
  });

  it('discover() mutates gameState and persists completion', () => {
    const m = new MapModel(fixtureRooms());
    m.discover('r1');
    expect(gameState.data.map.discovered).toContain('r1');
    expect(gameState.data.map.completion).toBe(50);
    expect(gameState.dirty).toBe(true);
  });

  it('getRegionCompletion is per-region and ignores secrets', () => {
    const m = new MapModel(fixtureRooms());
    expect(m.getRegionCompletion('moonlit_gate')).toBe(0);
    m.discover('r1');
    expect(m.getRegionCompletion('moonlit_gate')).toBe(50);
    expect(m.getRegionCompletion('hollow_keep')).toBe(100); // no rooms: vacuous
  });

  it('getRoomNode describes markers and discovery', () => {
    const m = new MapModel(fixtureRooms(), { bosses: BOSSES });
    const n1 = m.getRoomNode('r1');
    expect(n1).toMatchObject({
      roomId: 'r1', region: 'moonlit_gate', x: 0, y: 0,
      discovered: false, isSaveRoom: true, isTeleport: false, isBoss: false,
      hasUnexploredExit: true,
    });
    m.discover('r1');
    m.discover('r2');
    expect(m.getRoomNode('r1').hasUnexploredExit).toBe(false);
    expect(m.getRoomNode('r2').isTeleport).toBe(true);
    expect(m.getRoomNode('r2').isBoss).toBe(true);
    expect(m.getRoomNode('nope')).toBeNull();
  });

  it('getDiscoveredNodes hides undiscovered and unfound secret rooms', () => {
    const m = new MapModel(fixtureRooms());
    expect(m.getDiscoveredNodes()).toEqual([]);
    m.discover('r1');
    m.discover('r3'); // hidden but discovered -> renders
    const ids = m.getDiscoveredNodes().map((n) => n.roomId).sort();
    expect(ids).toEqual(['r1', 'r3']);
  });

  it('getUnexploredDoors lists exits to undiscovered rooms', () => {
    const m = new MapModel(fixtureRooms());
    m.discover('r1');
    const doors = m.getUnexploredDoors();
    expect(doors).toHaveLength(1);
    expect(doors[0]).toMatchObject({ from: 'r1', to: 'r2', dir: 'east', requires: [] });
    m.discover('r2');
    // r2 -> r1 discovered; r2 -> r3 undiscovered
    expect(m.getUnexploredDoors().map((d) => d.to)).toEqual(['r3']);
  });

  it('getMarkers returns discovered-only save/teleport/boss markers', () => {
    const m = new MapModel(fixtureRooms(), { bosses: BOSSES });
    expect(m.getMarkers()).toEqual({ save: [], teleport: [], boss: [] });
    m.discover('r1');
    m.discover('r2');
    const markers = m.getMarkers();
    expect(markers.save.map((n) => n.roomId)).toEqual(['r1']);
    expect(markers.teleport.map((n) => n.roomId)).toEqual(['r2']);
    expect(markers.boss.map((n) => n.roomId)).toEqual(['r2']);
    expect(m.getSaveRooms()).toHaveLength(1);
    expect(m.getTeleportRooms()).toHaveLength(1);
    expect(m.getBossRooms()).toHaveLength(1);
  });

  it('getUndiscoveredNeighbors never leaks unfound secret rooms', () => {
    const m = new MapModel(fixtureRooms());
    m.discover('r2');
    // r1 is an ordinary undiscovered neighbor -> hinted; r3 is hidden -> not leaked
    expect(m.getUndiscoveredNeighbors('r2').map((n) => n.roomId)).toEqual(['r1']);
    expect(m.getUndiscoveredNeighbors('nope')).toEqual([]);
  });

  it('getRegions lists regions from room defs', () => {
    const m = new MapModel(fixtureRooms());
    expect(m.getRegions()).toEqual(['moonlit_gate']);
  });
});
