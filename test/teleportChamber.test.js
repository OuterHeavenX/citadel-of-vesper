/**
 * TeleportChamber tests — discover on entry, destination list, travel through
 * a fake RoomManager, keyboard/gamepad navigation.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { TeleportChamber } from '../src/rooms/TeleportChamber.js';
import { gameState } from '../src/core/GameState.js';

function makeInput() {
  const pressed = new Set();
  return {
    justPressed: (a) => pressed.has(a),
    press(a) { pressed.add(a); },
    clear() { pressed.clear(); },
  };
}

function makeDeps() {
  const input = makeInput();
  const views = [];
  const roomManager = {
    loaded: [],
    async loadRoom(id) { this.loaded.push(id); },
  };
  const chamber = new TeleportChamber(roomManager, {
    gameState,
    inputManager: input,
    render: (v) => views.push({ ...v, targets: [...v.targets] }),
  });
  return { chamber, input, views, roomManager };
}

describe('TeleportChamber', () => {
  beforeEach(() => gameState.reset());

  it('bind() discovers the chamber on first entry (idempotent)', async () => {
    const { eventBus } = await import('../src/core/EventBus.js');
    const seen = [];
    const off = eventBus.on('teleport:discovered', (p) => seen.push(p));
    const { chamber } = makeDeps();
    try {
      chamber.bind({ id: 'gate_chamber' });
      expect(gameState.data.teleports).toContain('gate_chamber');
      expect(seen).toEqual([{ chamberId: 'gate_chamber' }]);
      chamber.bind({ id: 'gate_chamber' }); // re-entry: no duplicate, no re-emit
      expect(gameState.data.teleports.filter((t) => t === 'gate_chamber')).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(chamber.isActive()).toBe(true);
    } finally {
      off();
    }
  });

  it('interact lists discovered chambers and travels to the chosen one', async () => {
    const { chamber, input, roomManager } = makeDeps();
    gameState.discoverTeleport('gate_chamber');
    gameState.discoverTeleport('keep_chamber');
    chamber.bind({ id: 'keep_chamber' });

    input.press('confirm');
    chamber.update();
    input.clear();
    expect(chamber.mode).toBe('select');
    expect(chamber.targets).toEqual(['gate_chamber']); // current excluded

    input.press('confirm');
    chamber.update();
    input.clear();
    await Promise.resolve();

    expect(roomManager.loaded).toEqual(['gate_chamber']);
    // gameState.useTeleport emits 'teleport:used' { from, to } on the real bus
    expect(gameState.dirty).toBe(true);
  });

  it('cursor wraps with move_up/move_down across multiple targets', () => {
    const { chamber, input } = makeDeps();
    gameState.discoverTeleport('a');
    gameState.discoverTeleport('b');
    gameState.discoverTeleport('c');
    chamber.bind({ id: 'c' });

    input.press('confirm');
    chamber.update();
    input.clear();
    expect(chamber.targets).toEqual(['a', 'b']);
    expect(chamber.cursor).toBe(0);

    input.press('move_down');
    chamber.update();
    input.clear();
    expect(chamber.cursor).toBe(1);

    input.press('move_down');
    chamber.update();
    input.clear();
    expect(chamber.cursor).toBe(0); // wraps

    input.press('move_up');
    chamber.update();
    input.clear();
    expect(chamber.cursor).toBe(1); // wraps the other way
  });

  it('cancel backs out of select to prompt', () => {
    const { chamber, input } = makeDeps();
    gameState.discoverTeleport('a');
    chamber.bind({ id: 'b' });

    input.press('confirm');
    chamber.update();
    input.clear();
    expect(chamber.mode).toBe('select');

    input.press('cancel');
    chamber.update();
    input.clear();
    expect(chamber.mode).toBe('prompt');
    expect(chamber.isActive()).toBe(true);
  });

  it('move_up also begins interaction at the prompt (no dedicated interact action)', () => {
    const { chamber, input } = makeDeps();
    gameState.discoverTeleport('a');
    chamber.bind({ id: 'b' });

    input.press('move_up');
    chamber.update();
    input.clear();
    expect(chamber.mode).toBe('select');
  });

  it('requires a RoomManager with loadRoom', () => {
    expect(() => new TeleportChamber(null)).toThrow(/roomManager/);
    expect(() => new TeleportChamber({})).toThrow(/loadRoom/);
  });
});
