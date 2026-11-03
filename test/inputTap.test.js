/**
 * InputManager — sub-frame taps. A key pressed AND released between two
 * update() calls still reads as justPressed (fast mashing of the Pale Hour
 * Blade never drops a swing). DOM listeners are captured from a stub window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InputManager } from '../src/core/InputManager.js';

describe('InputManager tap latching', () => {
  let handlers;
  let im;
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;

  beforeEach(() => {
    handlers = {};
    globalThis.window = { addEventListener: (type, fn) => { handlers[type] = fn; } };
    im = new InputManager();
    im.init();
  });

  afterEach(() => {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  });

  const key = (type, code) => handlers[type]({ code, repeat: false, preventDefault() {} });

  it('a tap inside one frame still fires justPressed exactly once', () => {
    key('keydown', 'KeyJ');
    key('keyup', 'KeyJ');
    im.update();
    expect(im.justPressed('attack')).toBe(true);
    expect(im.isDown('attack')).toBe(false);
    im.update();
    expect(im.justPressed('attack')).toBe(false);
  });

  it('a held key fires once, not every frame', () => {
    key('keydown', 'KeyX');
    im.update();
    expect(im.justPressed('attack')).toBe(true);
    im.update();
    expect(im.justPressed('attack')).toBe(false);
    expect(im.isDown('attack')).toBe(true);
    key('keyup', 'KeyX');
    im.update();
    expect(im.justReleased('attack')).toBe(true);
  });

  it('touch taps latch the same way', () => {
    im.setTouchAction('attack', true);
    im.setTouchAction('attack', false);
    im.update();
    expect(im.justPressed('attack')).toBe(true);
  });

  it('losing focus drops pending taps', () => {
    key('keydown', 'KeyJ');
    handlers.blur();
    im.update();
    expect(im.justPressed('attack')).toBe(false);
  });
});
