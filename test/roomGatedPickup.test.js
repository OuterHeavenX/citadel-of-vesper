/**
 * Room — story-gated pickups (data/rooms.json `requiresFlag`), e.g. the
 * Pale Hour Blade appearing in the Sable Sanctum once the Matriarch falls.
 * Pickup is mocked (it needs a Phaser scene); Room's gating logic is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/props/Pickup.js', () => ({
  Pickup: class {
    constructor(scene, itemId, x, y, opts) {
      Object.assign(this, { itemId, x, y, opts, destroyed: false, collected: false });
    }
    destroy() { this.destroyed = true; }
  },
}));

const { Room } = await import('../src/rooms/Room.js');
const { gameState } = await import('../src/core/GameState.js');

const FLAG = 'boss_defeated_sable_matriarch';
const DEF = {
  id: 'hollow_keep_010',
  pickups: [
    { itemId: 'ember_tonic', x: 100, y: 200 },
    { itemId: 'pale_hour_blade', x: 480, y: 150, chest: true, requiresFlag: FLAG },
  ],
};

function makeRoom() {
  const room = new Room({}, DEF);
  room.ctx = { effectsManager: { burst: vi.fn() } };
  return room;
}

describe('Room story-gated pickups', () => {
  beforeEach(() => {
    delete gameState.data.flags[FLAG];
    delete gameState.data.chestStates['chest:hollow_keep_010:1'];
  });
  afterEach(() => {
    delete gameState.data.flags[FLAG];
    delete gameState.data.chestStates['chest:hollow_keep_010:1'];
  });

  it('holds a gated pickup back until its flag is set', () => {
    const room = makeRoom();
    room._buildPickups(DEF.pickups);
    expect(room.pickups.map((p) => p.itemId)).toEqual(['ember_tonic']);
    room.destroy();
  });

  it('reveals it live (with a shimmer) when the flag flips while the room is loaded', () => {
    const room = makeRoom();
    room._buildPickups(DEF.pickups);
    gameState.setFlag('some_other_flag', true);
    expect(room.pickups).toHaveLength(1);
    gameState.setFlag(FLAG, true);
    expect(room.pickups.map((p) => p.itemId)).toEqual(['ember_tonic', 'pale_hour_blade']);
    expect(room.ctx.effectsManager.burst).toHaveBeenCalledWith(480, 150, 'levelup');
    // Collecting it marks the chest looted.
    room.pickups[1].opts.onCollect();
    expect(gameState.data.chestStates['chest:hollow_keep_010:1']).toBe(true);
    delete gameState.data.flags.some_other_flag;
    room.destroy();
  });

  it('spawns immediately when the flag is already set, and never again once looted', () => {
    gameState.data.flags[FLAG] = true;
    const room = makeRoom();
    room._buildPickups(DEF.pickups);
    expect(room.pickups.map((p) => p.itemId)).toContain('pale_hour_blade');
    room.destroy();
    gameState.data.chestStates['chest:hollow_keep_010:1'] = true;
    const again = makeRoom();
    again._buildPickups(DEF.pickups);
    expect(again.pickups.map((p) => p.itemId)).not.toContain('pale_hour_blade');
    again.destroy();
  });

  it('stops listening once the room is destroyed', () => {
    const room = makeRoom();
    room._buildPickups(DEF.pickups);
    room.destroy();
    gameState.setFlag(FLAG, true);
    expect(room.pickups).toHaveLength(0);
  });
});
