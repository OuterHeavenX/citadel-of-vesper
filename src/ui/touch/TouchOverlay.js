/**
 * TouchOverlay — virtual joystick + buttons driving InputManager actions.
 *
 * Wave 5 (W5-UI). The overlay calls inputManager.setTouchAction() so touch
 * drives the SAME action pipeline as keyboard/gamepad (ARCHITECTURE §5) —
 * no separate gameplay code paths.
 *
 * Layout (480x270 internal):
 *   - left: virtual joystick (drag) -> move_left/right/up/down (8-way via
 *     combos, deadzone 0.35 of the stick radius)
 *   - right: ATTACK (big), JUMP, DASH, INTERACT(=confirm) buttons
 *   - top-right: small PAUSE / MAP / ITEMS buttons; top-left: QUICK USE
 * Hidden unless inputManager.getDevice() === 'touch' (spec §41); listens
 * to `input:deviceChanged` to show/hide itself.
 *
 * Headless-safe: the vector->direction math is the pure exported
 * directionFromVector(), covered by test/ui.test.js. The Phaser class is
 * duck-typed (no `import 'phaser'`).
 */
import { inputManager, Devices } from '../../core/InputManager.js';
import { eventBus } from '../../core/EventBus.js';
import { InkCss } from '../gothic.js';

const STICK_RADIUS = 44;
const STICK_DEADZONE = 0.35;

/**
 * Map a stick vector to digital move actions (pure, headless-testable).
 * @param {number} dx -1..1 @param {number} dy -1..1
 * @returns {{ move_left: boolean, move_right: boolean, move_up: boolean, move_down: boolean }}
 */
export function directionFromVector(dx, dy) {
  const mag = Math.hypot(dx, dy);
  const out = { move_left: false, move_right: false, move_up: false, move_down: false };
  if (!(mag > STICK_DEADZONE)) return out;
  // normalize so diagonal pushes still cross the threshold cleanly
  const nx = dx / Math.max(1, mag);
  const ny = dy / Math.max(1, mag);
  const T = 0.45; // axis threshold on the normalized vector
  if (nx < -T) out.move_left = true;
  else if (nx > T) out.move_right = true;
  if (ny < -T) out.move_up = true;
  else if (ny > T) out.move_down = true;
  return out;
}

/** Virtual buttons: [action, x, y, radius, label, color]. */
const BUTTONS = Object.freeze([
  ['attack', 428, 196, 26, 'ATK', '#a8353f'],
  ['jump', 372, 224, 20, 'JMP', '#4a6ea8'],
  ['dash', 428, 132, 18, 'DSH', '#6a6488'],
  ['confirm', 322, 190, 18, 'TALK', '#c9a227'],
]);

const SMALL_BUTTONS = Object.freeze([
  ['pause', 462, 18, 'II'],
  ['map', 436, 18, 'MAP'],
  ['inventory', 402, 18, 'BAG'],
  ['quick_use', 18, 18, 'USE'],
]);

export class TouchOverlay {
  /**
   * @param {object} scene Phaser Scene (duck-typed: add.graphics/text/zone)
   * @param {object} [deps]
   * @param {object} [deps.input] InputManager-like
   * @param {object} [deps.bus] EventBus-like
   */
  constructor(scene, deps = {}) {
    this.scene = scene;
    this.input = deps.input ?? inputManager;
    this.bus = deps.bus ?? eventBus;
    this._root = null;
    this._stickBase = null;
    this._stickKnob = null;
    this._stickPointerId = null;
    this._stickCx = 64;
    this._stickCy = 200;
    this._stickState = { move_left: false, move_right: false, move_up: false, move_down: false };
    this._unsub = null;
    this._visible = false;
  }

  /** Build the overlay and subscribe to device changes. */
  attach() {
    this._build();
    this._syncVisibility();
    this._unsub = this.bus.on('input:deviceChanged', () => this._syncVisibility());
  }

  /** @returns {boolean} */
  isVisible() {
    return this._visible;
  }

  /** @private */
  _syncVisibility() {
    const touch = this.input.getDevice?.() === Devices.TOUCH;
    this._visible = touch;
    try {
      this._root?.setVisible(touch);
    } catch {
      /* headless */
    }
    if (!touch) this._releaseAll();
  }

  /** @private build joystick + buttons (duck-typed scene calls) */
  _build() {
    const scene = this.scene;
    const root = scene.add.container(0, 0).setDepth(1900).setScrollFactor(0);
    this._root = root;

    // --- joystick base + knob ---
    const base = scene.add.graphics();
    base.lineStyle(2, 0x6a6488, 0.7);
    base.strokeCircle(this._stickCx, this._stickCy, STICK_RADIUS);
    base.fillStyle(0x100c18, 0.45);
    base.fillCircle(this._stickCx, this._stickCy, STICK_RADIUS);
    root.add(base);
    const knob = scene.add.graphics();
    knob.fillStyle(0xc9a227, 0.85);
    knob.fillCircle(this._stickCx, this._stickCy, 14);
    root.add(knob);
    this._stickBase = base;
    this._stickKnob = knob;

    const stickZone = scene.add.zone(this._stickCx, this._stickCy, STICK_RADIUS * 2.4, STICK_RADIUS * 2.4)
      .setInteractive();
    this._bindStick(stickZone);
    root.add(stickZone);

    // --- action buttons ---
    for (const [action, x, y, r, label, color] of BUTTONS) {
      root.add(this._makeButton(x, y, r, label, color, action));
    }
    for (const [action, x, y, label] of SMALL_BUTTONS) {
      root.add(this._makeButton(x, y, 13, label, '#453f5e', action, '7px'));
    }
  }

  /** @private circular button bound to a touch action */
  _makeButton(x, y, r, label, color, action, fontSize = '9px') {
    const scene = this.scene;
    const c = scene.add.container(x, y);
    const g = scene.add.graphics();
    g.fillStyle(0x100c18, 0.55);
    g.fillCircle(0, 0, r);
    g.lineStyle(1.5, PhaserColor(color), 0.9);
    g.strokeCircle(0, 0, r);
    const t = scene.add.text(0, 0, label, {
      fontFamily: 'monospace',
      fontSize,
      color: InkCss.ink,
    });
    t.setOrigin(0.5);
    const zone = scene.add.zone(0, 0, r * 2, r * 2).setInteractive();
    zone.on('pointerdown', () => {
      this.input.setTouchAction(action, true);
      g.clear();
      g.fillStyle(PhaserColor(color), 0.5);
      g.fillCircle(0, 0, r);
      g.lineStyle(1.5, PhaserColor(color), 1);
      g.strokeCircle(0, 0, r);
    });
    const release = () => {
      this.input.setTouchAction(action, false);
      g.clear();
      g.fillStyle(0x100c18, 0.55);
      g.fillCircle(0, 0, r);
      g.lineStyle(1.5, PhaserColor(color), 0.9);
      g.strokeCircle(0, 0, r);
    };
    zone.on('pointerup', release);
    zone.on('pointerout', release);
    c.add([g, t, zone]);
    return c;
  }

  /** @private joystick drag -> move_* touch actions */
  _bindStick(zone) {
    zone.on('pointerdown', (pointer) => {
      this._stickPointerId = pointer.id;
      this._moveStick(pointer);
    });
    zone.on('pointermove', (pointer) => {
      if (pointer.id === this._stickPointerId || pointer.isDown) this._moveStick(pointer);
    });
    const release = (pointer) => {
      if (pointer && pointer.id !== this._stickPointerId) return;
      this._stickPointerId = null;
      this._setStickState({ move_left: false, move_right: false, move_up: false, move_down: false });
      try {
        this._stickKnob?.clear?.();
        this._stickKnob?.fillStyle(0xc9a227, 0.85);
        this._stickKnob?.fillCircle(this._stickCx, this._stickCy, 14);
      } catch {
        /* headless */
      }
    };
    zone.on('pointerup', release);
    zone.on('pointerout', release);
  }

  /** @private */
  _moveStick(pointer) {
    const dx = (pointer.x - this._stickCx) / STICK_RADIUS;
    const dy = (pointer.y - this._stickCy) / STICK_RADIUS;
    const cl = Math.max(-1, Math.min(1, dx));
    const cy = Math.max(-1, Math.min(1, dy));
    this._setStickState(directionFromVector(cl, cy));
    try {
      this._stickKnob?.clear?.();
      this._stickKnob?.fillStyle(0xc9a227, 0.85);
      this._stickKnob?.fillCircle(
        this._stickCx + cl * STICK_RADIUS * 0.55,
        this._stickCy + cy * STICK_RADIUS * 0.55,
        14
      );
    } catch {
      /* headless */
    }
  }

  /** @private push a direction state into the touch action pipeline */
  _setStickState(next) {
    for (const action of Object.keys(this._stickState)) {
      if (this._stickState[action] !== next[action]) {
        this._stickState[action] = next[action];
        try {
          this.input.setTouchAction(action, next[action]);
        } catch {
          /* headless */
        }
      }
    }
  }

  /** @private release every touch action we own */
  _releaseAll() {
    this._setStickState({ move_left: false, move_right: false, move_up: false, move_down: false });
    for (const [action] of [...BUTTONS, ...SMALL_BUTTONS]) {
      try {
        this.input.setTouchAction(action, false);
      } catch {
        /* ignore */
      }
    }
  }

  /** Teardown. */
  destroy() {
    try {
      this._unsub?.();
    } catch {
      /* ignore */
    }
    this._releaseAll();
    try {
      this._root?.destroy();
    } catch {
      /* ignore */
    }
    this._root = null;
  }
}

/** @private '#rrggbb' -> 0xrrggbb */
function PhaserColor(css) {
  return parseInt(css.slice(1), 16);
}
