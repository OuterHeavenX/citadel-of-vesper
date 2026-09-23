/**
 * PlayerMovement unit tests — pure logic, no Phaser.
 * Movement integrates its own velocity and reads a duck-typed body
 * ({ velocity, blocked, touching }) plus an injected input facade,
 * so the whole state machine (coyote, buffers, dash, hitstun, drop-through)
 * is testable in node.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PlayerMovement } from '../src/player/PlayerMovement.js';
import { tuning } from '../src/config/tuning.js';

const DT = 1 / 60;

/** Fake input facade mirroring the InputManager read API. */
function makeInput() {
  const down = new Set();
  const pressed = new Set();
  let analogX = null;
  let analogY = null;
  return {
    isDown: (a) => down.has(a),
    justPressed: (a) => pressed.has(a),
    justReleased: () => false,
    axis: (name) => {
      if (name === 'move_x') {
        if (analogX !== null) return analogX;
        return (down.has('move_right') ? 1 : 0) - (down.has('move_left') ? 1 : 0);
      }
      if (name === 'move_y') {
        if (analogY !== null) return analogY;
        return down.has('move_down') ? 1 : 0;
      }
      return 0;
    },
    press(a) { down.add(a); pressed.add(a); },
    release(a) { down.delete(a); },
    clearEdges() { pressed.clear(); },
    setAnalog(x, y) { analogX = x; analogY = y; },
  };
}

function makeBody() {
  return {
    velocity: { x: 0, y: 0 },
    blocked: { down: false, up: false, left: false, right: false },
    touching: { down: false },
    checkCollision: { down: true },
  };
}

function makePlayer(body) {
  return {
    body,
    getStats: () => ({ getDerived: () => ({ moveSpeed: 1 }) }),
  };
}

function makeMovement() {
  const body = makeBody();
  const input = makeInput();
  const movement = new PlayerMovement(makePlayer(body), input);
  return { movement, body, input };
}

/** Run n frames, clearing one-frame edges between them. */
function step(movement, input, n = 1) {
  for (let i = 0; i < n; i++) {
    movement.update(DT);
    input.clearEdges();
  }
}

describe('PlayerMovement', () => {
  let movement, body, input;
  beforeEach(() => {
    ({ movement, body, input } = makeMovement());
  });

  it('jumps from the ground with the tuned velocity', () => {
    body.blocked.down = true;
    step(movement, input); // sync grounded
    input.press('jump');
    movement.update(DT);
    expect(movement.getVelocity().y).toBe(-tuning.jump.jumpVelocity);
    expect(movement.getState()).toBe('jump');
    expect(movement.isGrounded()).toBe(false);
  });

  it('coyote time allows a jump shortly after leaving a ledge', () => {
    body.blocked.down = true;
    step(movement, input);
    body.blocked.down = false; // walked off the ledge (no jump)
    input.press('jump');
    movement.update(DT); // within coyote window
    expect(movement.getVelocity().y).toBe(-tuning.jump.jumpVelocity);
    expect(movement.getState()).toBe('jump');
  });

  it('no jump after the coyote window expires; the press is buffered instead', () => {
    body.blocked.down = true;
    step(movement, input);
    body.blocked.down = false;
    step(movement, input, Math.ceil((tuning.jump.coyoteTime + 0.05) / DT));
    input.press('jump');
    movement.update(DT);
    expect(movement.getState()).toBe('fall'); // buffered, not jumped
    // Landing consumes the buffer.
    body.blocked.down = true;
    movement.update(DT);
    expect(movement.getState()).toBe('jump');
    expect(movement.getVelocity().y).toBeLessThan(0); // airborne from the buffered jump
  });

  it('jump buffering fires on landing when jump was pressed mid-air', () => {
    body.blocked.down = false;
    step(movement, input, 10); // airborne long enough to drain coyote
    input.press('jump');
    movement.update(DT);
    input.clearEdges();
    expect(movement.getState()).toBe('fall');
    body.blocked.down = true; // touch down before the buffer expires
    movement.update(DT);
    expect(movement.getState()).toBe('jump');
  });

  it('variable jump height: early release cuts the jump shorter', () => {
    const apex = (releaseAfterFrames) => {
      const m = makeMovement();
      m.body.blocked.down = true;
      step(m.movement, m.input);
      m.input.press('jump');
      m.movement.update(DT);
      m.input.clearEdges();
      m.body.blocked.down = false;
      let y = 0;
      let peak = 0;
      for (let f = 0; f < 120; f++) {
        if (f === releaseAfterFrames) m.input.release('jump');
        m.movement.update(DT);
        m.input.clearEdges();
        y += m.movement.getVelocity().y * DT;
        peak = Math.min(peak, y);
        if (m.movement.getVelocity().y > 0 && f > releaseAfterFrames + 5) break;
      }
      return -peak;
    };
    const held = apex(1000); // never released
    const cut = apex(4); // released almost immediately
    expect(held).toBeGreaterThan(cut * 1.5);
  });

  it('transitions idle -> run -> jump -> fall -> land -> idle', () => {
    body.blocked.down = true;
    step(movement, input, 3);
    expect(movement.getState()).toBe('idle');

    input.press('move_right');
    step(movement, input, 40);
    expect(['walk', 'run']).toContain(movement.getState());
    expect(movement.isFacingRight()).toBe(true);

    input.press('jump');
    movement.update(DT);
    input.clearEdges();
    body.blocked.down = false; // left the ground
    expect(movement.getState()).toBe('jump');

    step(movement, input, 60); // rise then fall
    expect(movement.getState()).toBe('fall');

    movement.vy = 300; // fast fall
    body.blocked.down = true;
    movement.update(DT);
    expect(movement.getState()).toBe('land');
    input.release('move_right'); // let go so we settle
    step(movement, input, Math.ceil((tuning.jump.landTime + 0.05) / DT));
    expect(movement.getState()).toBe('idle');
  });

  it('backdash bursts away from facing and locks horizontal input', () => {
    body.blocked.down = true;
    input.press('move_right');
    step(movement, input, 10); // facing right
    input.release('move_right');

    input.press('dash');
    movement.update(DT);
    input.clearEdges();
    expect(movement.getState()).toBe('dash');
    expect(movement.getVelocity().x).toBe(-tuning.dash.dashSpeed);
    expect(movement.isDashInvulnerable()).toBe(true);

    // Input ignored for the dash duration.
    input.press('move_right');
    step(movement, input, 5);
    expect(movement.getVelocity().x).toBe(-tuning.dash.dashSpeed);
    input.clearEdges();

    // Cooldown blocks an immediate second dash.
    step(movement, input, Math.ceil((tuning.dash.dashTime + 0.05) / DT));
    input.press('dash');
    movement.update(DT);
    expect(movement.getState()).not.toBe('dash');

    // After the cooldown the dash is available again.
    input.clearEdges();
    step(movement, input, Math.ceil((tuning.dash.dashCooldown + 0.05) / DT));
    input.press('dash');
    movement.update(DT);
    expect(movement.getState()).toBe('dash');
  });

  it('base kit has no air dash (gale_dash unlocks it in Wave 4)', () => {
    body.blocked.down = false;
    step(movement, input, 5);
    input.press('dash');
    movement.update(DT);
    expect(movement.getState()).not.toBe('dash');
  });

  it('knockback takes over velocity and locks input during hitstun', () => {
    body.blocked.down = true;
    step(movement, input);
    movement.applyKnockback(200, -100, 0.3);
    expect(movement.getState()).toBe('hitstun');
    expect(movement.getVelocity().x).toBe(200);

    input.press('move_right');
    const before = movement.getVelocity().x;
    step(movement, input, 6);
    // Input ignored; knockback decays instead.
    expect(movement.getVelocity().x).toBeLessThan(before);
    expect(movement.getState()).toBe('hitstun');

    step(movement, input, Math.ceil(0.4 / DT));
    expect(movement.getState()).not.toBe('hitstun');
    // Control returns: input now drives velocity.
    step(movement, input, 20);
    expect(movement.getVelocity().x).toBeGreaterThan(0);
  });

  it('down+jump on the ground drops through instead of jumping', () => {
    body.blocked.down = true;
    step(movement, input);
    input.press('move_down');
    input.press('jump');
    movement.update(DT);
    expect(movement.isDroppingThrough()).toBe(true);
    expect(movement.getVelocity().y).not.toBe(-tuning.jump.jumpVelocity);
    expect(movement.getState()).toBe('fall');
  });

  it('crouch slows movement while down is held', () => {
    body.blocked.down = true;
    step(movement, input);
    input.press('move_down');
    input.press('move_right');
    step(movement, input, 60);
    expect(movement.getState()).toBe('crouch');
    expect(Math.abs(movement.getVelocity().x)).toBeLessThanOrEqual(
      tuning.movement.maxSpeed * tuning.movement.crouchSpeedMult + 1,
    );
  });

  it('hard reversal enters the turn state', () => {
    body.blocked.down = true;
    input.press('move_right');
    step(movement, input, 40); // at speed
    input.release('move_right');
    input.press('move_left');
    movement.update(DT);
    expect(movement.getState()).toBe('turn');
    expect(movement.isFacingRight()).toBe(false);
  });

  it('dead state ignores input and zeroes velocity', () => {
    body.blocked.down = true;
    step(movement, input);
    movement.setDead();
    input.press('move_right');
    input.press('jump');
    step(movement, input, 10);
    expect(movement.getState()).toBe('dead');
    expect(movement.getVelocity()).toEqual({ x: 0, y: 0 });
  });

  it('tunables are read from tuning.js, not hardcoded', () => {
    expect(tuning.movement.maxSpeed).toBeGreaterThan(0);
    expect(tuning.jump.jumpVelocity).toBeGreaterThan(0);
    expect(tuning.jump.coyoteTime).toBeGreaterThan(0);
    expect(tuning.jump.jumpBuffer).toBeGreaterThan(0);
    expect(tuning.dash.dashSpeed).toBeGreaterThan(0);
    expect(tuning.combat.iframesAfterHit).toBeGreaterThan(0);
    expect(tuning.knockback.knockbackDecay).toBeGreaterThan(0);
  });
});
