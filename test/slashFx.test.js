/**
 * SlashFx — detached weapon slash (Pale Hour Blade). Headless: duck-typed
 * scene + sprites, isolated EventBus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus.js';
import { SlashFx, slashLayout, SLASH_POOL_SIZE, SLASH_DEPTH } from '../src/effects/SlashFx.js';
import effectsLayout from '../assets/effects/effects.json';

function makeSprite() {
  return {
    x: 0, y: 0, visible: false, frame: null, texture: null, flipX: false, flipY: false,
    setOrigin: vi.fn(function () { return this; }),
    setDepth: vi.fn(function (d) { this.depth = d; return this; }),
    setBlendMode: vi.fn(function (m) { this.blend = m; return this; }),
    setVisible(v) { this.visible = v; return this; },
    setTexture(t, f) { this.texture = t; this.frame = f; return this; },
    setFrame(f) { this.frame = f; return this; },
    setFlipX(v) { this.flipX = v; return this; },
    setFlipY(v) { this.flipY = v; return this; },
    setScale(s) { this.scale = s; return this; },
    setTint(t) { this.tint = t; return this; },
    setAlpha(a) { this.alpha = a; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    destroy: vi.fn(),
  };
}

function makeScene() {
  const sprites = [];
  return {
    sprites,
    add: { sprite: vi.fn(() => { const s = makeSprite(); sprites.push(s); return s; }) },
  };
}

const BASE = {
  weaponId: 'pale_hour_blade', texture: 'fx_slash_quick', facing: 1, comboStep: 0,
  flipY: false, duration: 0.2, offsetX: 2, offsetY: -28, tint: 0xffffff, scale: 1,
};

describe('SlashFx', () => {
  let bus;
  let fx;
  let scene;
  let owner;

  beforeEach(() => {
    bus = new EventBus();
    owner = { x: 100, y: 240 };
    fx = new SlashFx({ bus });
    scene = makeScene();
    fx.attachScene(scene, { getOwnerPosition: () => owner });
  });

  it('reads the fx_slash_quick sheet layout (frames + pivot) from effects.json', () => {
    const meta = effectsLayout.effects.fx_slash_quick;
    const layout = slashLayout('fx_slash_quick');
    expect(layout.frames).toBe(meta.frames);
    expect(layout.frameW).toBe(meta.frameWidth);
    expect(layout.frameH).toBe(meta.frameHeight);
    expect(layout.pivotX).toBe(meta.pivot.x);
    expect(layout.pivotY).toBe(meta.pivot.y);
    expect(slashLayout('no_such_fx')).toBeNull();
  });

  it('preallocates a hidden, additive, in-front-of-Lucien sprite pool', () => {
    expect(scene.sprites).toHaveLength(SLASH_POOL_SIZE);
    for (const s of scene.sprites) {
      expect(s.visible).toBe(false);
      expect(s.depth).toBe(SLASH_DEPTH);
      expect(s.blend).toBe(1); // Phaser.BlendModes.ADD
    }
  });

  it("spawns on 'player:slashed' and places the pivot on the shoulder anchor", () => {
    bus.emit('player:slashed', BASE);
    expect(fx.activeCount).toBe(1);
    const s = scene.sprites[0];
    expect(s.visible).toBe(true);
    expect(s.texture).toBe('fx_slash_quick');
    expect(s.frame).toBe(0);
    expect(s.flipX).toBe(false);
    // Pivot pixel must land at owner + (offsetX, offsetY).
    const { frameW, frameH, pivotX, pivotY } = slashLayout('fx_slash_quick');
    const pivotWorldX = s.x - frameW / 2 + pivotX;
    const pivotWorldY = s.y - frameH / 2 + pivotY;
    expect(pivotWorldX).toBeCloseTo(owner.x + 2);
    expect(pivotWorldY).toBeCloseTo(owner.y - 28);
  });

  it('mirrors around the pivot when facing left and when flipped vertically', () => {
    const { frameW, frameH, pivotX, pivotY } = slashLayout('fx_slash_quick');
    bus.emit('player:slashed', { ...BASE, facing: -1, flipY: true });
    const s = scene.sprites[0];
    expect(s.flipX).toBe(true);
    expect(s.flipY).toBe(true);
    // Mirrored pivot = (frameW - pivotX, frameH - pivotY) from the top-left.
    const pivotWorldX = s.x - frameW / 2 + (frameW - pivotX);
    const pivotWorldY = s.y - frameH / 2 + (frameH - pivotY);
    expect(pivotWorldX).toBeCloseTo(owner.x - 2);
    expect(pivotWorldY).toBeCloseTo(owner.y - 28);
  });

  it('follows its owner while alive', () => {
    bus.emit('player:slashed', BASE);
    const s = scene.sprites[0];
    const x0 = s.x;
    owner.x += 10;
    fx.update(16);
    expect(s.x).toBeCloseTo(x0 + 10);
  });

  it('steps through every frame over its duration, then hides', () => {
    const frames = slashLayout('fx_slash_quick').frames;
    bus.emit('player:slashed', { ...BASE, duration: 0.2 });
    const s = scene.sprites[0];
    const seen = new Set([s.frame]);
    for (let i = 0; i < 11; i++) {
      fx.update(18);
      if (s.visible) seen.add(s.frame);
    }
    expect(seen.size).toBe(frames);
    fx.update(50);
    expect(s.visible).toBe(false);
    expect(fx.activeCount).toBe(0);
  });

  it('update(0) holds the current frame (hit pause)', () => {
    bus.emit('player:slashed', BASE);
    fx.update(60);
    const s = scene.sprites[0];
    const f = s.frame;
    for (let i = 0; i < 20; i++) fx.update(0);
    expect(s.frame).toBe(f);
    expect(s.visible).toBe(true);
  });

  it('recycles the oldest slash when the pool is exhausted', () => {
    for (let i = 0; i < SLASH_POOL_SIZE; i++) bus.emit('player:slashed', { ...BASE, duration: 1 });
    expect(fx.activeCount).toBe(SLASH_POOL_SIZE);
    const first = fx._debug.slots[0].born;
    bus.emit('player:slashed', { ...BASE, duration: 1 });
    expect(fx.activeCount).toBe(SLASH_POOL_SIZE);
    expect(fx._debug.slots[0].born).toBeGreaterThan(first);
  });

  it('ignores unknown textures and clears on room change', () => {
    bus.emit('player:slashed', { ...BASE, texture: 'not_a_sheet' });
    expect(fx.activeCount).toBe(0);
    bus.emit('player:slashed', BASE);
    bus.emit('room:changed', { from: 'a', to: 'b' });
    expect(fx.activeCount).toBe(0);
    expect(scene.sprites.every((s) => !s.visible)).toBe(true);
  });

  it('detach() unsubscribes and destroys views', () => {
    fx.detach();
    for (const s of scene.sprites) expect(s.destroy).toHaveBeenCalled();
    bus.emit('player:slashed', BASE);
    expect(fx.activeCount).toBe(0);
  });

  it('works headless before attach (state only, no views)', () => {
    const bare = new SlashFx({ bus: new EventBus() });
    expect(bare.spawn(BASE)).toBe(0);
    expect(() => bare.update(16)).not.toThrow();
  });
});
