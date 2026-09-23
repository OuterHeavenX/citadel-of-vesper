/**
 * World connectivity tests (spec §28, §54): exits resolve, world is reachable.
 * Mirrors the structural checks in scripts/validate.js so CI tests and the
 * validator agree.
 */
import { describe, expect, it } from 'vitest';
import { loadJson } from './helpers.js';

const rooms = loadJson('data/rooms.json');
const START = 'moonlit_gate_001';

describe('world connectivity', () => {
  it('every exit target exists', () => {
    const ids = new Set(rooms.map((r) => r.id));
    for (const room of rooms) {
      for (const exit of room.exits ?? []) {
        expect(ids.has(exit.target), `${room.id} exit ${exit.id} -> ${exit.target}`).toBe(true);
      }
    }
  });

  it('every room is reachable from the start room', () => {
    const adj = new Map(rooms.map((r) => [r.id, (r.exits ?? []).map((e) => e.target)]));
    const seen = new Set([START]);
    const queue = [START];
    while (queue.length) {
      for (const next of adj.get(queue.shift()) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const room of rooms) {
      expect(seen.has(room.id), `${room.id} unreachable from ${START}`).toBe(true);
    }
  });

  it('map grid cells are unique', () => {
    const cells = new Map();
    for (const room of rooms) {
      const key = `${room.map.x},${room.map.y}`;
      expect(cells.has(key), `${room.id} collides on map cell ${key}`).toBe(false);
      cells.set(key, room.id);
    }
  });
});
