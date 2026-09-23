/**
 * SaveSanctum tests — rest heals, save:rested emitted, slot write via fake
 * SaveManager, keyboard/gamepad navigation through the input facade.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SaveSanctum } from '../src/rooms/SaveSanctum.js';
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
  const emitted = [];
  const eventBus = { emit: (e, p) => emitted.push({ event: e, payload: p }) };
  const writes = [];
  const saveManager = {
    async write(slot, obj) { writes.push({ slot, obj }); return { ok: true }; },
  };
  const views = [];
  const lanterns = [];
  const sanctum = new SaveSanctum({
    gameState,
    eventBus,
    inputManager: input,
    saveManager,
    render: (v) => views.push({ ...v }),
    lanternFx: undefined, // default no-op
  });
  sanctum.setLanternFx((roomId) => lanterns.push(roomId));
  return { sanctum, input, emitted, writes, views, lanterns };
}

describe('SaveSanctum', () => {
  beforeEach(() => gameState.reset());

  it('rest heals to full, emits save:rested, fires the lantern hook', async () => {
    const { sanctum, input, emitted, lanterns } = makeDeps();
    gameState.setHp(10);
    gameState.setMp(3);
    const maxHp = gameState.data.player.maxHp;
    const maxMp = gameState.data.player.maxMp;

    sanctum.activate({ id: 'moonlit_gate_save' });
    expect(sanctum.isActive()).toBe(true);
    expect(sanctum.mode).toBe('prompt');

    input.press('confirm');
    sanctum.update();
    input.clear();
    await Promise.resolve(); // let the async rest settle

    expect(gameState.data.player.hp).toBe(maxHp);
    expect(gameState.data.player.mp).toBe(maxMp);
    // gameState.rest() emits 'player:healed' on the real bus (its own contract);
    // the sanctum emits the room-scoped 'save:rested' through its injected bus.
    expect(emitted).toContainEqual({
      event: 'save:rested',
      payload: { roomId: 'moonlit_gate_save' },
    });
    expect(lanterns).toEqual(['moonlit_gate_save']);
    expect(sanctum.mode).toBe('slots');
  });

  it('slot select navigates 1–3 and writes via SaveManager', async () => {
    const { sanctum, input, writes } = makeDeps();
    sanctum.activate({ id: 'r_save' });
    input.press('move_up'); // also begins the rest sequence
    sanctum.update();
    input.clear();
    await Promise.resolve();
    expect(sanctum.mode).toBe('slots');

    input.press('move_down');
    sanctum.update();
    input.clear();
    expect(sanctum.slot).toBe(2);

    input.press('confirm');
    sanctum.update();
    input.clear();
    await Promise.resolve();

    expect(writes).toHaveLength(1);
    expect(writes[0].slot).toBe(2);
    expect(writes[0].obj.player.hp).toBe(gameState.data.player.maxHp);
    expect(sanctum.mode).toBe('done');
  });

  it('cancel backs out of slot select; cancel at prompt deactivates', async () => {
    const { sanctum, input } = makeDeps();
    sanctum.activate({ id: 'r_save' });
    input.press('confirm');
    sanctum.update();
    input.clear();
    await Promise.resolve();
    expect(sanctum.mode).toBe('slots');

    input.press('cancel');
    sanctum.update();
    input.clear();
    expect(sanctum.mode).toBe('prompt');

    input.press('cancel');
    sanctum.update();
    input.clear();
    expect(sanctum.isActive()).toBe(false);
  });

  it('surface save failure in the view message without breaking', async () => {
    const { sanctum, input, views } = makeDeps();
    sanctum.saves = {
      async write() { return { ok: false, error: 'disk full' }; },
    };
    sanctum.activate({ id: 'r_save' });
    input.press('confirm');
    sanctum.update();
    input.clear();
    await Promise.resolve();
    input.press('confirm');
    sanctum.update();
    input.clear();
    await Promise.resolve();
    expect(sanctum.mode).toBe('done');
    expect(views[views.length - 1].message).toMatch(/disk full/);
  });
});
