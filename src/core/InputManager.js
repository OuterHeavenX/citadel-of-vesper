/**
 * InputManager — unified keyboard / gamepad / touch input (docs/CONTROLS.md).
 *
 * CONTRACT:
 * - Game code NEVER reads raw keys, pads, or touch state. It reads ACTIONS:
 *     'move_left' | 'move_right' | 'move_up' | 'move_down' | 'crouch'
 *     'jump' | 'attack' | 'secondary' | 'dash' | 'ability' | 'ability2'
 *     'map' | 'inventory' | 'pause' | 'confirm' | 'cancel' | 'menu_tab_next' | 'menu_tab_prev' | 'quick_use'
 * - Per-frame: isDown(action), justPressed(action), justReleased(action),
 *   axis('move_x') -> -1..1, axis('move_y') -> -1..1.
 * - Device detection: last-used device tracked; emits 'input:deviceChanged'
 *   with { device } on change. UI reads getDevice()/getPrompt() for glyphs.
 * - Bindings are data (DEFAULT_*_BINDINGS). Remapping persists via the
 *   SaveManager settings store (Wave 5 exposes the UI; mutators exist here).
 * - Touch overlay drives the SAME actions via setTouchAction() — no separate
 *   gameplay code paths for touch.
 * - Gamepad: standard mapping, Xbox-style default; polled in update();
 *   connect/disconnect events handled.
 */
import { eventBus } from './EventBus.js';

export const Actions = Object.freeze([
  'move_left', 'move_right', 'move_up', 'move_down', 'crouch',
  'jump', 'attack', 'secondary', 'dash', 'ability', 'ability2',
  'map', 'inventory', 'pause', 'confirm', 'cancel',
  'menu_tab_next', 'menu_tab_prev', 'quick_use',
]);

/** Keyboard defaults per docs/CONTROLS.md. Values are KeyboardEvent.code strings. */
export const DEFAULT_KEYBOARD_BINDINGS = Object.freeze({
  move_left: ['ArrowLeft', 'KeyA'],
  move_right: ['ArrowRight', 'KeyD'],
  move_up: ['ArrowUp', 'KeyW'],
  move_down: ['ArrowDown', 'KeyS'],
  crouch: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ'],
  attack: ['KeyJ', 'KeyX'],
  secondary: ['KeyK', 'KeyC'],
  dash: ['ShiftLeft', 'ShiftRight', 'KeyL'],
  ability: ['KeyU', 'KeyV'],
  ability2: ['KeyI', 'KeyB'],
  map: ['Tab', 'KeyM'],
  inventory: ['KeyE', 'KeyI'],
  quick_use: ['KeyF'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'Space', 'KeyJ'],
  cancel: ['Escape', 'KeyK'],
  menu_tab_next: ['KeyE', 'BracketRight'],
  menu_tab_prev: ['KeyQ', 'BracketLeft'],
});

/**
 * Gamepad mapping (standard mapping, Xbox-style default per docs/CONTROLS.md).
 * Buttons: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 View, 9 Menu,
 *          12-15 D-pad; axes[0]/axes[1] = left stick.
 */
export const DEFAULT_GAMEPAD_BINDINGS = Object.freeze({
  move_left: [{ type: 'axis', index: 0, dir: -1 }, { type: 'button', index: 14 }],
  move_right: [{ type: 'axis', index: 0, dir: 1 }, { type: 'button', index: 15 }],
  move_up: [{ type: 'axis', index: 1, dir: -1 }, { type: 'button', index: 12 }],
  move_down: [{ type: 'axis', index: 1, dir: 1 }, { type: 'button', index: 13 }],
  crouch: [{ type: 'button', index: 13 }],
  jump: [{ type: 'button', index: 0 }], // A
  attack: [{ type: 'button', index: 2 }], // X
  secondary: [{ type: 'button', index: 3 }], // Y
  dash: [{ type: 'button', index: 1 }], // B
  ability: [{ type: 'button', index: 4 }], // LB
  ability2: [{ type: 'button', index: 5 }], // RB
  map: [{ type: 'button', index: 8 }], // View
  inventory: [{ type: 'button', index: 9 }], // Menu
  quick_use: [{ type: 'button', index: 7 }], // RT
  pause: [{ type: 'button', index: 9 }], // Menu
  confirm: [{ type: 'button', index: 0 }], // A
  cancel: [{ type: 'button', index: 1 }], // B
  menu_tab_next: [{ type: 'button', index: 5 }], // RB
  menu_tab_prev: [{ type: 'button', index: 4 }], // LB
});

export const Devices = Object.freeze({
  KEYBOARD: 'keyboard',
  GAMEPAD_XBOX: 'gamepad-xbox',
  GAMEPAD_PLAYSTATION: 'gamepad-playstation',
  STEAM_DECK: 'steamdeck',
  TOUCH: 'touch',
});

const AXIS_DEADZONE = 0.25;
const ACTIVITY_DEADZONE = 0.3;

/** Keys we must swallow so the browser doesn't steal them (Tab focus, Space scroll). */
const PREVENT_DEFAULT_CODES = new Set([
  'Tab', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);

const CODE_LABELS = {
  Space: 'Space', Tab: 'Tab', Escape: 'Esc', Enter: 'Enter',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Backquote: '`', BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

const XBOX_BUTTON_LABELS = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'View', 9: 'Menu', 12: 'D-Pad ↑', 13: 'D-Pad ↓', 14: 'D-Pad ←', 15: 'D-Pad →',
};

const PS_BUTTON_LABELS = {
  0: '✕', 1: '○', 2: '□', 3: '△', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
  8: 'Create', 9: 'Options', 12: 'D-Pad ↑', 13: 'D-Pad ↓', 14: 'D-Pad ←', 15: 'D-Pad →',
};

/** @param {string} id Gamepad.id @returns {string} one of the gamepad Devices */
function detectGamepadType(id) {
  const s = `${id}`.toLowerCase();
  if (s.includes('deck') || s.includes('steam')) return Devices.STEAM_DECK;
  if (s.includes('playstation') || s.includes('dualsense') || s.includes('dualshock') || s.includes('sony')) {
    return Devices.GAMEPAD_PLAYSTATION;
  }
  return Devices.GAMEPAD_XBOX; // standard mapping default
}

export class InputManager {
  constructor() {
    /** @type {string} one of Devices */
    this.device = Devices.KEYBOARD;
    /** @type {Record<string, string[]>} mutable copies (remappable, Wave 5) */
    this.keyboardBindings = structuredClone(DEFAULT_KEYBOARD_BINDINGS);
    /** @type {Record<string, Array<{type:string,index:number,dir?:number}>>} */
    this.gamepadBindings = structuredClone(DEFAULT_GAMEPAD_BINDINGS);

    this._keyDown = new Set(); // KeyboardEvent.code currently held
    this._touchDown = new Map(); // action -> bool (virtual buttons)
    this._padButtons = []; // bool[] snapshot from last poll
    this._padAxes = []; // number[] snapshot from last poll
    this._padId = '';

    this._down = new Map(); // action -> bool (this frame)
    this._justPressed = new Map(); // action -> bool
    this._justReleased = new Map(); // action -> bool
    for (const a of Actions) {
      this._down.set(a, false);
      this._justPressed.set(a, false);
      this._justReleased.set(a, false);
    }

    this._initialized = false;
  }

  // ------------------------------------------------------------------ setup

  /** Wire DOM + gamepad listeners. Called once from BootScene. Idempotent. */
  init() {
    if (this._initialized || typeof window === 'undefined') return;
    this._initialized = true;

    window.addEventListener('keydown', (e) => {
      if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
      if (!e.repeat) {
        this._keyDown.add(e.code);
        this._setDevice(Devices.KEYBOARD);
      }
    });
    window.addEventListener('keyup', (e) => {
      this._keyDown.delete(e.code);
    });
    // Stuck-key insurance: losing focus releases everything.
    window.addEventListener('blur', () => {
      this._keyDown.clear();
      this._touchDown.clear();
    });

    window.addEventListener('gamepadconnected', (e) => {
      this._padId = e.gamepad?.id ?? '';
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._padButtons = [];
      this._padAxes = [];
      this._padId = '';
    });

    // First touch contact anywhere => touch device (overlay shows itself).
    window.addEventListener('touchstart', () => {
      this._setDevice(Devices.TOUCH);
    }, { passive: true });
  }

  // ------------------------------------------------------------------ frame

  /**
   * Poll gamepads and recompute per-action edge states. Call once per frame
   * from the active scene BEFORE any gameplay reads.
   */
  update() {
    this._pollGamepad();
    for (const action of Actions) {
      const was = this._down.get(action);
      const is = this._isActionDown(action);
      this._down.set(action, is);
      this._justPressed.set(action, is && !was);
      this._justReleased.set(action, !is && was);
    }
  }

  /** @private */
  _pollGamepad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads
      ? navigator.getGamepads()
      : [];
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) { pad = p; break; }
    }
    if (!pad) {
      this._padButtons = [];
      this._padAxes = [];
      return;
    }
    this._padId = pad.id || this._padId;
    this._padButtons = pad.buttons.map((b) => b.pressed);
    this._padAxes = [...pad.axes];

    // Any button/axis activity => this is the live device.
    let active = false;
    for (const b of this._padButtons) {
      if (b) { active = true; break; }
    }
    if (!active) {
      for (const a of this._padAxes) {
        if (Math.abs(a) > ACTIVITY_DEADZONE) { active = true; break; }
      }
    }
    if (active) this._setDevice(detectGamepadType(this._padId));
  }

  /** @private @param {string} action @returns {boolean} */
  _isActionDown(action) {
    // keyboard
    const codes = this.keyboardBindings[action] ?? [];
    for (const code of codes) {
      if (this._keyDown.has(code)) return true;
    }
    // gamepad
    const binds = this.gamepadBindings[action] ?? [];
    for (const b of binds) {
      if (b.type === 'button') {
        if (this._padButtons[b.index]) return true;
      } else if (b.type === 'axis') {
        const v = this._padAxes[b.index] ?? 0;
        if (Math.abs(v) > AXIS_DEADZONE && Math.sign(v) === b.dir) return true;
      }
    }
    // touch
    if (this._touchDown.get(action)) return true;
    return false;
  }

  // ------------------------------------------------------------------- read

  /** @param {string} action @returns {boolean} held this frame */
  isDown(action) {
    return this._down.get(action) ?? false;
  }

  /** @param {string} action @returns {boolean} true only on the press frame */
  justPressed(action) {
    return this._justPressed.get(action) ?? false;
  }

  /** @param {string} action @returns {boolean} true only on the release frame */
  justReleased(action) {
    return this._justReleased.get(action) ?? false;
  }

  /**
   * Analog-friendly axis. Gamepad stick contributes its analog value;
   * digital sources contribute ±1; results are clamped to [-1, 1].
   * @param {'move_x'|'move_y'} name @returns {number} -1..1
   */
  axis(name) {
    if (name === 'move_x') {
      const digital = (this.isDown('move_right') ? 1 : 0) - (this.isDown('move_left') ? 1 : 0);
      const analog = Math.abs(this._padAxes[0] ?? 0) > AXIS_DEADZONE ? this._padAxes[0] : 0;
      return Math.max(-1, Math.min(1, digital + analog));
    }
    if (name === 'move_y') {
      const digital = (this.isDown('move_down') ? 1 : 0) - (this.isDown('move_up') ? 1 : 0);
      const analog = Math.abs(this._padAxes[1] ?? 0) > AXIS_DEADZONE ? this._padAxes[1] : 0;
      return Math.max(-1, Math.min(1, digital + analog));
    }
    return 0;
  }

  // ----------------------------------------------------------------- device

  /** @returns {string} current device id (see Devices) */
  getDevice() {
    return this.device;
  }

  /** @private */
  _setDevice(device) {
    if (this.device === device) return;
    this.device = device;
    eventBus.emit('input:deviceChanged', { device });
  }

  // ----------------------------------------------------------------- prompt

  /**
   * Prompt glyph for an action in the current device's language,
   * e.g. getPrompt('jump') -> 'Space' | 'A' | '✕' | 'JUMP'.
   * @param {string} action @returns {string}
   */
  getPrompt(action) {
    if (this.device === Devices.GAMEPAD_PLAYSTATION) {
      return this._gamepadPrompt(action, PS_BUTTON_LABELS);
    }
    if (
      this.device === Devices.GAMEPAD_XBOX ||
      this.device === Devices.STEAM_DECK
    ) {
      return this._gamepadPrompt(action, XBOX_BUTTON_LABELS);
    }
    if (this.device === Devices.TOUCH) {
      return action.replace(/_/g, ' ').toUpperCase();
    }
    const codes = this.keyboardBindings[action] ?? [];
    return codes.length ? this._codeLabel(codes[0]) : '';
  }

  /** @private */
  _gamepadPrompt(action, labels) {
    const binds = this.gamepadBindings[action] ?? [];
    for (const b of binds) {
      if (b.type === 'button') return labels[b.index] ?? `Btn${b.index}`;
      if (b.type === 'axis') return b.index === 0 ? 'L-Stick ↔' : 'L-Stick ↕';
    }
    return '';
  }

  /** @private @param {string} code KeyboardEvent.code @returns {string} */
  _codeLabel(code) {
    if (CODE_LABELS[code]) return CODE_LABELS[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    return code;
  }

  // ------------------------------------------------------------------ touch

  /**
   * Touch overlay calls this to inject virtual button state into the SAME
   * action pipeline as physical inputs.
   * @param {string} action one of Actions @param {boolean} down
   */
  setTouchAction(action, down) {
    if (!Actions.includes(action)) return;
    this._touchDown.set(action, !!down);
    if (down) this._setDevice(Devices.TOUCH);
  }

  // --------------------------------------------------------------- remapping

  /** @returns {Record<string, string[]>} live (mutable) keyboard bindings */
  getKeyboardBindings() {
    return this.keyboardBindings;
  }

  /** @param {Record<string, string[]>} bindings replaces keyboard bindings */
  setKeyboardBindings(bindings) {
    this.keyboardBindings = structuredClone(bindings);
  }

  /** @returns {Record<string, Array>} live (mutable) gamepad bindings */
  getGamepadBindings() {
    return this.gamepadBindings;
  }

  /** @param {Record<string, Array>} bindings replaces gamepad bindings */
  setGamepadBindings(bindings) {
    this.gamepadBindings = structuredClone(bindings);
  }
}

/** Shared singleton. */
export const inputManager = new InputManager();
