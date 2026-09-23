/**
 * PlayerMovement — Lucien's locomotion (spec §12). PLAYER FEEL IS TOP PRIORITY.
 *
 * CONTRACT:
 * - Reads ALL constants from src/config/tuning.js. No magic numbers here.
 * - States: idle | walk | run | crouch | jump | fall | land | turn |
 *   dash | hitstun | dead. Exposes getState().
 * - Features: variable jump height (jump cut), coyote time, jump buffering,
 *   backdash (away from facing, with i-frames per tuning.dash.dashIframes),
 *   drop-through platforms (down+jump), air control, knockback takeover
 *   with hitstun, landing state.
 * - Stairs (spec §12): implemented as slope tiles; this code treats slopes
 *   via Arcade Physics — no special-case stair state.
 * - Moving-platform carry: Wave 3 rooms may call setPlatformVelocity(x, y);
 *   the platform's velocity is added to the body's each frame.
 * - Gravity is integrated HERE (body.allowGravity must be false): this keeps
 *   jump-cut/coyote math deterministic and unit-testable without Phaser.
 *   Arcade still resolves collisions; grounded is read from
 *   body.blocked.down / body.touching.down each frame.
 * - Input is read from an injected input facade
 *   { isDown, justPressed, justReleased, axis } defaulting to the
 *   inputManager singleton — pass a fake in tests.
+ * - Double jump (Wave 3): an AbilityManager is injected via the constructor
+ *   (3rd arg) or setAbilityManager(). Airborne jump presses first consume
+ *   coyote, then — if unlocked traversal grants extra jumps (moonrise_leap:
+ *   extraJumps 1) — fire a bonus jump at tuning.jump.doubleJumpVelocityMult
+ *   of jumpVelocity. The bonus jump (the genuinely-extra one) calls the
+ *   double-jump FX callback set via setDoubleJumpFx(fn) (default no-op):
+ *   the scene wires the pale-crescent visual + 'dash' sfx there. Movement
+ *   itself never touches audio/particles. Coyote time and jump buffering
+ *   apply to the FIRST jump only. Jump count resets on landing.
 * - Actions used: 'move_left' | 'move_right' | 'jump' | 'dash' | 'crouch',
 *   axis('move_x'), axis('move_y') (down = +1). Crouch also triggers when
 *   axis('move_y') > 0.5.
 *
 * Wave 2 implements against tuning.js. Game-feel pass (§67) tunes via config.
 */
import { inputManager } from '../core/InputManager.js';
import { tuning } from '../config/tuning.js';

const DOWN_THRESHOLD = 0.5;

export class PlayerMovement {
  /**
   * @param {object} player the Player facade (duck-type: { body, getStats() })
   *   getStats() must expose at least { moveSpeed } (multiplier).
   * @param {object} [input] input facade; defaults to the inputManager singleton
   * @param {object|null} [abilityManager] AbilityManager-like
   *   { has(id), getExtraJumps()? }; null = no traversal abilities (tests)
   */
  constructor(player, input = inputManager, abilityManager = null) {
    this.player = player;
    this.input = input;
    this._abilityManager = abilityManager;
    /** Double-jump FX hook (pale crescent visual + sfx); scene injects. */
    this._doubleJumpFx = () => {};

    /** @type {string} current movement state */
    this.state = 'idle';
    /** @type {number} 1 = right, -1 = left */
    this.facing = 1;

    // Authoritative velocity (px/s); synced to body each frame.
    this.vx = 0;
    this.vy = 0;
    this.grounded = false;

    // Timers (seconds).
    this._coyote = 0;
    this._buffer = 0;
    this._dashTimer = 0;
    this._dashCooldown = 0;
    this._dashIframes = 0;
    this._hitstun = 0;
    this._landTimer = 0;
    this._turnTimer = 0;
    this._dropThroughTimer = 0;
    this._fallSpeed = 0; // vy captured on the last airborne frame

    this._airDashesLeft = tuning.dash.airDashes;
    this._jumpedThisFrame = false;
    this._platformVel = { x: 0, y: 0 };
    this._jumpsUsed = 0; // jumps consumed since last landing (double-jump count)
  }

  // ------------------------------------------------------------------ update

  /** @param {number} dt seconds */
  update(dt) {
    if (dt <= 0) return;
    this._tickTimers(dt);

    if (this.state === 'dead') {
      this.vx = 0;
      this.vy = 0;
      this._writeBody();
      return;
    }

    const wasGrounded = this.grounded;
    this._syncGrounded();
    if (!wasGrounded && this.grounded) this._onLand();
    if (wasGrounded && !this.grounded && !this._jumpedThisFrame) {
      this._coyote = tuning.jump.coyoteTime;
    }
    this._jumpedThisFrame = false;

    if (this.state === 'hitstun') this._updateHitstun(dt);
    else if (this._dashTimer > 0) this._updateDash(dt);
    else if (this.grounded) this._updateGround(dt);
    else this._updateAir(dt);

    this._writeBody();
  }

  /** @private */
  _tickTimers(dt) {
    this._coyote = Math.max(0, this._coyote - dt);
    this._buffer = Math.max(0, this._buffer - dt);
    this._dashTimer = Math.max(0, this._dashTimer - dt);
    this._dashCooldown = Math.max(0, this._dashCooldown - dt);
    this._dashIframes = Math.max(0, this._dashIframes - dt);
    this._hitstun = Math.max(0, this._hitstun - dt);
    this._landTimer = Math.max(0, this._landTimer - dt);
    this._turnTimer = Math.max(0, this._turnTimer - dt);
    this._dropThroughTimer = Math.max(0, this._dropThroughTimer - dt);
  }

  /** @private */
  _syncGrounded() {
    const body = this.player.body;
    if (!body) return;
    this.grounded =
      !!(body.blocked?.down || body.touching?.down) &&
      this._dropThroughTimer <= 0;
  }

  /** @private */
  _onLand() {
    this._airDashesLeft = tuning.dash.airDashes;
    this._jumpsUsed = 0; // landing refills the jump count
    if (this._buffer > 0) {
      // Buffered jump fires the instant we touch down.
      this._buffer = 0;
      this._doJump();
      return;
    }
    if (this._fallSpeed >= tuning.jump.landMinFallSpeed) {
      this._landTimer = tuning.jump.landTime;
      this.state = 'land';
    }
  }

  /** @private @param {number} dt */
  _updateGround(dt) {
    const mv = tuning.movement;
    const moveSpeed = this.player.getStats().getDerived().moveSpeed;
    const moveX = this.input.axis('move_x');
    const down = this._isDownHeld();

    // Jump (direct, buffered, or drop-through).
    if (this.input.justPressed('jump')) {
      if (down) {
        this._requestDropThrough();
        return;
      }
      this._doJump();
      return;
    }

    // Backdash.
    if (this.input.justPressed('dash') && this._tryDash(false)) return;

    // Crouch.
    if (down) {
      this._approachTarget(moveX * mv.maxSpeed * mv.crouchSpeedMult * moveSpeed, dt, mv.acceleration);
      this.state = 'crouch';
      if (moveX !== 0) this.facing = Math.sign(moveX);
      return;
    }

    // Horizontal locomotion.
    const target = moveX * mv.maxSpeed * moveSpeed;
    const reversing = moveX !== 0 && this.vx !== 0 && Math.sign(moveX) !== Math.sign(this.vx);
    const accel = mv.acceleration * (reversing ? mv.turnBoost : 1);
    this._approachTarget(target, dt, accel, mv.deceleration);
    if (moveX !== 0) this.facing = Math.sign(moveX);

    if (this._landTimer > 0) {
      this.state = 'land';
    } else if (reversing && Math.abs(this.vx) > mv.walkSpeed) {
      this._turnTimer = tuning.jump.turnTime;
      this.state = 'turn';
    } else {
      this._setLocomotionState(moveX);
    }
  }

  /** @private @param {number} dt */
  _updateAir(dt) {
    const mv = tuning.movement;
    const jp = tuning.jump;
    const moveSpeed = this.player.getStats().getDerived().moveSpeed;
    const moveX = this.input.axis('move_x');
    if (moveX !== 0) this.facing = Math.sign(moveX);

    // Jump: coyote grace, then ability-gated double jump, else buffer the
    // press for landing. Coyote/buffer semantics belong to the FIRST jump.
    if (this.input.justPressed('jump')) {
      if (this._coyote > 0) {
        this._coyote = 0;
        this._doJump();
        return;
      }
      const extra = this._extraJumps();
      if (extra > 0 && this._jumpsUsed < 1 + extra) {
        // Bonus jump (moonrise_leap). The genuinely-extra one — i.e. any
        // jump after the first this airtime — gets the crescent FX.
        this._doJump(this._jumpsUsed >= 1);
        return;
      }
      this._buffer = jp.jumpBuffer;
    }

    // Air dash (ability-gated; base kit has 0).
    if (this.input.justPressed('dash') && this._airDashesLeft > 0 && this._tryDash(true)) {
      return;
    }

    // Variable gravity: light while rising+held, heavy on release, heaviest falling.
    const rising = this.vy < 0;
    const held = this.input.isDown('jump');
    const g = rising ? (held ? jp.jumpGravity : jp.jumpCutGravity) : jp.gravity;
    this.vy = Math.min(this.vy + g * dt, jp.maxFallSpeed);
    this._fallSpeed = this.vy;

    const target = moveX * mv.maxSpeed * moveSpeed;
    this._approachTarget(target, dt, mv.airAcceleration, mv.airDeceleration);

    this.state = rising ? 'jump' : 'fall';
  }

  /** @private @param {number} dt */
  _updateDash(dt) {
    // Horizontal locked for the dash duration; slight gravity for weight.
    this.vy = Math.min(this.vy + tuning.jump.gravity * 0.25 * dt, tuning.jump.maxFallSpeed);
    if (!this.grounded) this._fallSpeed = this.vy;
    this.state = 'dash';
  }

  /** @private @param {number} dt */
  _updateHitstun(dt) {
    const kb = tuning.knockback;
    // Knockback decays; gravity still applies so hits arc.
    this.vx = this._approachValue(this.vx, 0, kb.knockbackDecay * dt);
    this.vy = Math.min(this.vy + tuning.jump.gravity * dt, tuning.jump.maxFallSpeed);
    if (!this.grounded) this._fallSpeed = this.vy;
    if (this._hitstun <= 0) {
      this.state = this.grounded ? 'idle' : 'fall';
    } else {
      this.state = 'hitstun';
    }
  }

  // ----------------------------------------------------------------- actions

  /** @private @param {boolean} [extra] true for the ability-granted bonus jump */
  _doJump(extra = false) {
    const mult = extra ? (tuning.jump.doubleJumpVelocityMult ?? 0.95) : 1;
    this.vy = -tuning.jump.jumpVelocity * mult;
    this.grounded = false;
    this._coyote = 0;
    this._landTimer = 0;
    this._jumpedThisFrame = true;
    this._jumpsUsed += 1;
    this.state = 'jump';
    if (extra) this._doubleJumpFx();
  }

  /** @private @returns {number} bonus mid-air jumps granted by unlocks */
  _extraJumps() {
    const am = this._abilityManager;
    if (!am) return 0;
    if (typeof am.getExtraJumps === 'function') return am.getExtraJumps();
    return am.has('moonrise_leap') ? 1 : 0;
  }

  /**
   * Backdash: burst away from facing. Grounded dash is always available
   * (cooldown-gated); air dash consumes one air charge.
   * @private @param {boolean} fromAir @returns {boolean} true if started
   */
  _tryDash(fromAir) {
    if (this._dashCooldown > 0 || this.state === 'hitstun' || this.state === 'dead') {
      return false;
    }
    if (fromAir) this._airDashesLeft -= 1;
    this._dashTimer = tuning.dash.dashTime;
    this._dashCooldown = tuning.dash.dashCooldown;
    this._dashIframes = tuning.dash.dashIframes;
    this.vx = -this.facing * tuning.dash.dashSpeed;
    this.vy = 0;
    this._buffer = 0;
    this.state = 'dash';
    return true;
  }

  /** @private down+jump: fall through a one-way platform instead of jumping */
  _requestDropThrough() {
    this._dropThroughTimer = tuning.jump.dropThroughTime;
    this.vy = Math.max(this.vy, 60); // nudge downward so we leave the surface
    this.grounded = false;
    this._jumpedThisFrame = true;
    this.state = 'fall';
  }

  /** @private */
  _isDownHeld() {
    return this.input.axis('move_y') > DOWN_THRESHOLD || this.input.isDown('crouch');
  }

  /**
   * Move vx toward target with accel (driving) or decel (no input).
   * @private
   */
  _approachTarget(target, dt, accel, decel = accel) {
    const rate = target === 0 ? decel : accel;
    this.vx = this._approachValue(this.vx, target, rate * dt);
  }

  /** @private */
  _approachValue(v, target, maxDelta) {
    if (v < target) return Math.min(v + maxDelta, target);
    return Math.max(v - maxDelta, target);
  }

  /** @private idle|walk|run from speed */
  _setLocomotionState(moveX) {
    if (Math.abs(moveX) < 0.1 && Math.abs(this.vx) < 1) {
      this.vx = 0;
      this.state = 'idle';
    } else if (Math.abs(this.vx) <= tuning.movement.walkSpeed) {
      this.state = 'walk';
    } else {
      this.state = 'run';
    }
  }

  /** @private push velocity (plus platform carry) into the Arcade body */
  _writeBody() {
    const body = this.player.body;
    if (!body || !body.velocity) return;
    body.velocity.x = this.vx + this._platformVel.x;
    body.velocity.y = this.vy + this._platformVel.y;
  }

  // ------------------------------------------------------------------- api

  /** @returns {string} */
  getState() {
    return this.state;
  }

  /** @returns {boolean} */
  isGrounded() {
    return this.grounded;
  }

  /** @returns {boolean} */
  isFacingRight() {
    return this.facing > 0;
  }

  /** @returns {boolean} dash i-frames currently active */
  isDashInvulnerable() {
    return this._dashIframes > 0;
  }

  /** @returns {boolean} currently falling through a one-way platform */
  isDroppingThrough() {
    return this._dropThroughTimer > 0;
  }

  /** @returns {{x:number,y:number}} authoritative velocity (px/s) */
  getVelocity() {
    return { x: this.vx, y: this.vy };
  }

  /**
   * External knockback (from DamageSystem via Player.takeDamage).
   * Takes over velocity and locks input for the hitstun duration.
   * @param {number} x px/s @param {number} y px/s
   * @param {number} [hitStun] seconds (defaults to tuning light hitstun)
   */
  applyKnockback(x, y, hitStun = tuning.combat.hitStunLight) {
    if (this.state === 'dead') return;
    this.vx = x;
    this.vy = y;
    this._hitstun = hitStun;
    this._dashTimer = 0;
    this._buffer = 0;
    this.state = 'hitstun';
  }

  /** Wave 3 hook: moving platforms report their velocity here. */
  setPlatformVelocity(x, y) {
    this._platformVel.x = x;
    this._platformVel.y = y;
  }

  /**
   * Wave 3 hook: attach the AbilityManager (traversal unlocks gate the
   * double jump). May also be passed as the 3rd constructor argument.
   * @param {object|null} abilityManager AbilityManager-like
   */
  setAbilityManager(abilityManager) {
    this._abilityManager = abilityManager;
  }

  /**
   * Wave 3 hook: double-jump FX callback, fired on the bonus (extra) jump
   * only. The scene injects the pale-crescent visual + 'dash' sfx here;
   * default is a no-op so headless tests and pre-ability gameplay are
   * unaffected.
   * @param {Function} fn () => void
   */
  setDoubleJumpFx(fn) {
    this._doubleJumpFx = typeof fn === 'function' ? fn : () => {};
  }

  /** @returns {number} jumps consumed since last landing */
  getJumpsUsed() {
    return this._jumpsUsed;
  }

  /** Enter the dead state: input ignored, velocity zeroed. */
  setDead() {
    this.state = 'dead';
    this.vx = 0;
    this.vy = 0;
    this._dashTimer = 0;
    this._hitstun = 0;
    this._buffer = 0;
    this._jumpsUsed = 0;
    this._writeBody();
  }
}
