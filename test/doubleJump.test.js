/**
 * Double-jump (Moonrise Leap) physics tests — headless, no Phaser.
 * Mirrors the fake-input harness from test/playerMovement.test.js.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PlayerMovement } from '../src/player/PlayerMovement.js';
import { tuning } from '../src/config/tuning.js';

const DT = 1 / 60;

function makeInput() {
  const down = new Set();
  const pressed = new Set();
  return {
    isDown: (a) => down.has(a),
    justPressed: (a) => pressed.has(a),
    justReleased: () => false,
    axis: (name) => {
      if (name === 'move_x') return (down.has('move_right') ? 1 : 0) - (down.has('move_left') ? 1 : 0);
      if (name === 'move_y') return down.has('move_down') ? 1 : 0;
      return 0;
    },
    press(a) { down.add(a); pressed.add(a); },
    release(a) { down.delete(a); },
    clearEdges() { pressed.clear(); },
  };
}

function makeBody() {
  return {
    velocity: { x: 0, y: 0 },
    blocked: { down: false, up: false, left: false, right: false },
    touching: { down: false },
  };
}

function makePlayer(body) {
  return { body, getStats: () => ({ getDerived: () => ({ moveSpeed: 1 }) }) };
}

/** Minimal AbilityManager-like: only moonrise_leap matters here. */
function makeAbilityManager(unlocked) {
  return {
    has: (id) => unlocked && id === 'moonrise_leap',
    getExtraJumps: () => (unlocked ? 1 : 0),
  };
}

function makeMovement(unlocked, fx) {
  const body = makeBody();
  const input = makeInput();
  const movement = new PlayerMovement(makePlayer(body), input, makeAbilityManager(unlocked));
  if (fx) movement.setDoubleJumpFx(fx);
  return { movement, body, input };
}

function step(movement, input, n = 1) {
  for (let i = 0; i < n; i++) {
    movement.update(DT);
    input.clearEdges();
  }
}

describe('PlayerMovement double jump (moonrise_leap)', () => {
  it('does nothing extra without the ability (no abilityManager)', () => {
    const body = makeBody();
    const input = makeInput();
    const movement = new PlayerMovement(makePlayer(body), input); // null abilityManager
    let fxCalls = 0;
    movement.setDoubleJumpFx(() => fxCalls++);
    body.blocked.down = true;
    input.press('jump');
    step(movement, input, 1); // ground jump
    expect(movement.getJumpsUsed()).toBe(1);
    body.blocked.down = false;
    input.press('jump');
    step(movement, input, 1); // mid-air press: buffered, not a jump
    expect(movement.getJumpsUsed()).toBe(1);
    expect(fxCalls).toBe(0);
  });

  it('fires the bonus jump mid-air with the crescent FX hook', () => {
    let fxCalls = 0;
    const { movement, body, input } = makeMovement(true, () => fxCalls++);
    body.blocked.down = true;
    input.press('jump');
    step(movement, input, 1); // first jump (full velocity)
    expect(movement.getJumpsUsed()).toBe(1);
    expect(fxCalls).toBe(0);

    body.blocked.down = false;
    step(movement, input, 20); // rise a while, still airborne
    input.press('jump');
    const before = movement.getVelocity().y;
    step(movement, input, 1);
    const after = movement.getVelocity().y;
    expect(movement.getJumpsUsed()).toBe(2);
    expect(fxCalls).toBe(1); // crescent FX fires on the bonus jump
    // Bonus jump re-launches upward at 0.95× tuned velocity
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(-tuning.jump.jumpVelocity * 0.95, 4);
  });

  it('allows only one bonus jump per airtime', () => {
    const { movement, body, input } = makeMovement(true);
    body.blocked.down = true;
    input.press('jump');
    step(movement, input, 1);
    body.blocked.down = false;
    step(movement, input, 10);
    input.press('jump');
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(2);
    step(movement, input, 10);
    input.press('jump');
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(2); // third press: no jump left
  });

  it('resets the jump count on landing', () => {
    const { movement, body, input } = makeMovement(true);
    body.blocked.down = true;
    input.press('jump');
    step(movement, input, 1);
    body.blocked.down = false;
    step(movement, input, 10);
    input.press('jump');
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(2);
    // land again
    body.blocked.down = true;
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(0);
    // full double jump available again
    input.press('jump');
    step(movement, input, 1);
    body.blocked.down = false;
    step(movement, input, 10);
    input.press('jump');
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(2);
  });

  it('first air jump after walking off a ledge is a normal jump, second gets FX', () => {
    let fxCalls = 0;
    const { movement, body, input } = makeMovement(true, () => fxCalls++);
    body.blocked.down = true;
    step(movement, input, 5); // standing
    body.blocked.down = false; // walk off ledge (coyote expires quickly)
    step(movement, input, 10); // coyote gone
    input.press('jump');
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(1);
    expect(fxCalls).toBe(0); // first air jump: no crescent
    expect(movement.getVelocity().y).toBeCloseTo(-tuning.jump.jumpVelocity, 4);
    step(movement, input, 10);
    input.press('jump');
    step(movement, input, 1);
    expect(movement.getJumpsUsed()).toBe(2);
    expect(fxCalls).toBe(1); // the extra jump: crescent
  });
});
